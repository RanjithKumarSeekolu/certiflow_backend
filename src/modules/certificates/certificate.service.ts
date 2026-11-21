import path from "path";
import prisma from "../../config/db";
import { generateCertificateNumber, generateVerificationHash, signDownloadToken, verifyDownloadToken } from "../../utils/crypto";
import { PdfCertificateGenerator } from "../../workers/pdf.worker";
import { StandinWhatsAppProvider } from "../../integrations/whatsapp-provider";
import { BatchStatus, CertificateStatus, JobStatus, Prisma, Role } from "@prisma/client";
import { publish, DeferError } from "../../queues/broker";
import { Q } from "../../queues/queue-names";
import { emitBatchEvent } from "../../realtime/events";

/** Thrown for expected business-rule failures so controllers can map them to HTTP codes. */
export class CertificateError extends Error {
  constructor(message: string, public readonly status: 403 | 404 | 409 | 410) {
    super(message);
  }
}

export class CertificateService {
  /**
   * Masks candidate name to protect candidate privacy during public lookups.
   * "Rahul Kumar" -> "R***l K***r"
   */
  public static maskName(fullName: string): string {
    return fullName
      .split(" ")
      .map((part) => {
        if (part.length <= 2) return part[0] + "*";
        return part[0] + "*".repeat(part.length - 2) + part[part.length - 1];
      })
      .join(" ");
  }

  /**
   * Admin re-trigger for an APPROVED batch: re-opens exhausted (FAILED) deliveries and enqueues the
   * batch again. Normal flow needs no call: approval enqueues it, and the worker sweeper catches misses.
   */
  public static async requeueBatch(batchId: string) {
    const batch = await prisma.batch.findUnique({ where: { id: batchId } });
    if (!batch) throw new CertificateError("Batch not found", 404);
    if (batch.status !== BatchStatus.APPROVED) {
      throw new CertificateError(`Batch is '${batch.status}'; certificates can only be issued for APPROVED batches`, 409);
    }
    await prisma.deliveryJob.updateMany({
      where: { certificate: { batchId }, status: JobStatus.FAILED },
      data: { status: JobStatus.PENDING, attempts: 0 },
    });
    await publish(Q.issue, { batchId });
    return { batchId, status: "queued" };
  }

  /**
   * Step 1 (worker): create one certificate row per candidate. Idempotent and safe under concurrency:
   * candidateId is unique, so a concurrent issuer's row is reused. Returns null if the batch is gone
   * or no longer APPROVED.
   */
  public static async ensureCertificates(batchId: string) {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { candidates: { include: { certificate: true } } },
    });
    if (!batch || batch.status !== BatchStatus.APPROVED) return null;

    const baseUrl = process.env.PUBLIC_APP_URL || "http://localhost:8081";
    const certificates = [];

    for (const candidate of batch.candidates) {
      if (candidate.certificate) {
        certificates.push(candidate.certificate);
        continue;
      }
      const certNumber = generateCertificateNumber();
      const issuedAt = new Date();
      const hash = generateVerificationHash({
        candidateId: candidate.id,
        candidateName: candidate.fullName,
        nationalId: candidate.nationalId,
        courseName: batch.courseName,
        score: candidate.score,
        grade: candidate.grade,
        batchId: batch.id,
        issuedAt,
      });
      try {
        certificates.push(
          await prisma.certificate.create({
            data: {
              certificateNumber: certNumber,
              candidateId: candidate.id,
              batchId: batch.id,
              verificationHash: hash,
              qrCodeData: `${baseUrl}/api/verify/${certNumber}`,
              status: CertificateStatus.VALID,
              issuedAt,
            },
          })
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const existing = await prisma.certificate.findUnique({ where: { candidateId: candidate.id } });
          if (!existing) throw err; // clash was on certificateNumber/hash, not candidate: retry
          certificates.push(existing);
        } else {
          throw err;
        }
      }
    }
    return certificates;
  }

  /** Step 2 (worker): render the PDF once. Returns false if the certificate no longer exists. */
  public static async renderPdf(certificateId: string): Promise<boolean> {
    const certificate = await prisma.certificate.findUnique({
      where: { id: certificateId },
      include: { candidate: true, batch: true },
    });
    if (!certificate) return false;
    if (certificate.pdfUrl) return true;

    const pdfUrl = await PdfCertificateGenerator.generateCertificatePdf({
      certificateNumber: certificate.certificateNumber,
      candidateName: certificate.candidate.fullName,
      courseName: certificate.batch.courseName,
      grade: certificate.candidate.grade,
      score: certificate.candidate.score,
      issueDate: certificate.issuedAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
      verificationHash: certificate.verificationHash,
      verificationUrl: certificate.qrCodeData,
    });
    await prisma.certificate.update({ where: { id: certificateId }, data: { pdfUrl } });
    return true;
  }

  /**
   * Step 3 (worker): one WhatsApp attempt. Throws to be retried by the queue; throws DeferError if
   * another worker holds the job. Never sends for a cancelled certificate.
   */
  public static async deliverCertificate(certificateId: string): Promise<void> {
    const certificate = await prisma.certificate.findUnique({
      where: { id: certificateId },
      include: { candidate: true, batch: true },
    });
    if (!certificate || certificate.status === CertificateStatus.REVOKED) return;
    if (!certificate.pdfUrl) throw new Error("PDF not ready yet");

    const baseUrl = process.env.PUBLIC_APP_URL || "http://localhost:8081";
    const idempotencyKey = `wa_delivery_${certificate.candidateId}_${certificate.id}`;
    const job = await prisma.deliveryJob.upsert({
      where: { idempotencyKey },
      update: {},
      create: { certificateId, idempotencyKey, recipientPhone: certificate.candidate.phone, status: JobStatus.PENDING },
    });
    if (job.status === JobStatus.COMPLETED) return;

    // Claim atomically; a job left PROCESSING by a crashed worker is reclaimable after STALE_PROCESSING_MS.
    const staleMs = Number(process.env.STALE_PROCESSING_MS) || 60_000;
    const claim = await prisma.deliveryJob.updateMany({
      where: {
        id: job.id,
        OR: [
          { status: { in: [JobStatus.PENDING, JobStatus.FAILED] } },
          { status: JobStatus.PROCESSING, updatedAt: { lt: new Date(Date.now() - staleMs) } },
        ],
      },
      data: { status: JobStatus.PROCESSING },
    });
    if (claim.count === 0) throw new DeferError("Delivery in progress elsewhere");

    try {
      await StandinWhatsAppProvider.sendMessage({
        to: certificate.candidate.phone,
        templateName: "skilling_certificate_issued",
        parameters: {
          candidateName: certificate.candidate.fullName,
          courseName: certificate.batch.courseName,
          certificateNumber: certificate.certificateNumber,
          downloadUrl: `${baseUrl}/api/certificates/${certificate.id}/download?token=${signDownloadToken(certificate.id)}`,
        },
        idempotencyKey,
      });
    } catch (err: any) {
      await prisma.deliveryJob.update({
        where: { id: job.id },
        data: { status: JobStatus.PENDING, attempts: { increment: 1 }, lastError: String(err?.message ?? err) },
      });
      throw err;
    }
    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: { status: JobStatus.COMPLETED, attempts: { increment: 1 }, deliveredAt: new Date(), lastError: null },
    });
    await emitBatchEvent(certificate.batchId, "certificate.delivered");
  }

  /** Called when the queue gives up on a delivery: mark it FAILED so operators can see and re-drive it. */
  public static async markDeliveryExhausted(certificateId: string, reason: string): Promise<void> {
    await prisma.deliveryJob.updateMany({
      where: { certificateId, status: { not: JobStatus.COMPLETED } },
      data: { status: JobStatus.FAILED, lastError: reason },
    });
    const certificate = await prisma.certificate.findUnique({ where: { id: certificateId } });
    if (certificate) await emitBatchEvent(certificate.batchId, "certificate.delivery_failed");
  }

  /**
   * Public verification (no login). Always answered from the database, so a revoked
   * certificate can never be reported valid by a stale cache. Returns masked, minimal data.
   */
  public static async verifyCertificate(identifier: string) {
    const certificate = await prisma.certificate.findFirst({
      where: { OR: [{ certificateNumber: identifier }, { verificationHash: identifier }] },
      include: { candidate: true, batch: true },
    });

    if (!certificate) {
      return { valid: false, status: "NOT_FOUND", message: "No certificate found matching the provided code" };
    }

    return {
      valid: certificate.status === CertificateStatus.VALID,
      status: certificate.status,
      certificateNumber: certificate.certificateNumber,
      candidateName: this.maskName(certificate.candidate.fullName),
      courseName: certificate.batch.courseName,
      grade: certificate.candidate.grade,
      issuedAt: certificate.issuedAt,
      revokedAt: certificate.revokedAt,
      revocationReason: certificate.revocationReason,
    };
  }

  /** Resolves a signed download link to a file path. The link is the only credential. */
  public static async resolveDownload(certificateId: string, token: string): Promise<{ filePath: string; fileName: string }> {
    if (!token || !verifyDownloadToken(certificateId, token)) {
      throw new CertificateError("Invalid or expired download link", 403);
    }
    const certificate = await prisma.certificate.findUnique({ where: { id: certificateId } });
    if (!certificate || !certificate.pdfUrl) throw new CertificateError("Certificate not found", 404);
    if (certificate.status === CertificateStatus.REVOKED) {
      throw new CertificateError("This certificate has been cancelled", 410);
    }
    const fileName = `${certificate.certificateNumber}.pdf`;
    return { filePath: path.join(PdfCertificateGenerator.ensureOutputDir(), fileName), fileName };
  }

  /** State office cancellation: atomic, can't double-revoke, audited in the same transaction. */
  public static async revokeCertificate(certificateId: string, reason: string, officerId: string) {
    const revoked = await prisma.$transaction(async (tx) => {
      const certificate = await tx.certificate.findUnique({ where: { id: certificateId } });
      if (!certificate) throw new CertificateError("Certificate not found", 404);

      const changed = await tx.certificate.updateMany({
        where: { id: certificateId, status: CertificateStatus.VALID },
        data: { status: CertificateStatus.REVOKED, revokedAt: new Date(), revokedBy: officerId, revocationReason: reason },
      });
      if (changed.count === 0) throw new CertificateError("Certificate is already revoked", 409);

      await tx.auditLog.create({
        data: {
          entityType: "CERTIFICATE",
          entityId: certificate.id,
          action: "CERTIFICATE_REVOKED",
          actorId: officerId,
          actorRole: Role.STATE_OFFICE,
          batchId: certificate.batchId,
          details: { reason, certificateNumber: certificate.certificateNumber },
        },
      });

      return tx.certificate.findUniqueOrThrow({ where: { id: certificateId } });
    });
    await emitBatchEvent(revoked.batchId, "certificate.revoked");
    return revoked;
  }
}
