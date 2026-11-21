import prisma from "../config/db";
import { BatchStatus, CertificateStatus, JobStatus } from "@prisma/client";
import { publish } from "../queues/broker";
import { Q } from "../queues/queue-names";

/**
 * Safety net for lost messages (broker down at approval time, a message lost in a crash).
 * Re-publishes stuck work; every consumer is idempotent so duplicates are harmless.
 * Skips exhausted (FAILED) deliveries and cancelled certificates, and anything younger than
 * SWEEP_MIN_AGE_MS so it doesn't race messages still in flight.
 */
export async function sweepOnce(): Promise<number> {
  const minAge = Number(process.env.SWEEP_MIN_AGE_MS) || 60_000;
  const staleMs = Number(process.env.STALE_PROCESSING_MS) || 60_000;
  const cutoff = new Date(Date.now() - minAge);
  const staleCutoff = new Date(Date.now() - staleMs);
  let published = 0;

  const batches = await prisma.batch.findMany({
    where: { status: BatchStatus.APPROVED, approvedAt: { lt: cutoff }, candidates: { some: { certificate: { is: null } } } },
    select: { id: true },
    take: 100,
  });
  for (const b of batches) { await publish(Q.issue, { batchId: b.id }); published++; }

  const needPdf = await prisma.certificate.findMany({
    where: { status: CertificateStatus.VALID, pdfUrl: null, createdAt: { lt: cutoff }, batch: { status: BatchStatus.APPROVED } },
    select: { id: true },
    take: 500,
  });
  for (const c of needPdf) { await publish(Q.render, { certificateId: c.id }); published++; }

  const needSend = await prisma.certificate.findMany({
    where: {
      status: CertificateStatus.VALID,
      pdfUrl: { not: null },
      updatedAt: { lt: cutoff },
      OR: [
        { deliveryJobs: { none: {} } },
        { deliveryJobs: { some: { status: JobStatus.PENDING, updatedAt: { lt: cutoff } } } },
        { deliveryJobs: { some: { status: JobStatus.PROCESSING, updatedAt: { lt: staleCutoff } } } },
      ],
    },
    select: { id: true },
    take: 500,
  });
  for (const c of needSend) { await publish(Q.deliver, { certificateId: c.id }); published++; }

  return published;
}
