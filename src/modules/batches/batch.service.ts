import * as XLSX from "xlsx";
import prisma from "../../config/db";
import { CandidateRowSchema, OfficerReviewInput } from "./batch.schema";
import { AuthenticatedUser } from "../../middlewares/auth.middleware";
import { BatchStatus, Role, ApprovalDecision, Prisma } from "@prisma/client";
import crypto from "crypto";
import { slaDeadlineFromNow } from "../../config/env";

export interface SpreadsheetValidationError {
  row: number;
  field: string;
  message: string;
}

export class BatchService {
  static async createBatch(centreUserId: string, courseName: string) {
    const centre = await prisma.trainingCentre.findFirst({
      where: { userId: centreUserId },
    });

    if (!centre) {
      throw new Error("No training centre associated with this user account");
    }

    const year = new Date().getFullYear();
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    const batchNumber = `BATCH-${year}-${rand}`;

    const batch = await prisma.batch.create({
      data: {
        batchNumber,
        courseName,
        centreId: centre.id,
        status: BatchStatus.DRAFT,
      },
      include: {
        centre: { include: { district: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        entityType: "BATCH",
        entityId: batch.id,
        action: "BATCH_CREATED",
        actorId: centreUserId,
        actorRole: Role.CENTRE,
        batchId: batch.id,
        details: { batchNumber, courseName },
      },
    });

    return batch;
  }

  /**
   * Lean list (no candidate rows, no PII). `inbox` = batches waiting for THIS user's action:
   * centre -> sent back, district -> pending and not yet voted this cycle, quality/state -> their step.
   */
  static async getBatches(user: AuthenticatedUser, opts: { inbox?: boolean; status?: BatchStatus } = {}) {
    const where: Prisma.BatchWhereInput = {};
    if (user.role === Role.CENTRE) {
      const centre = await prisma.trainingCentre.findFirst({ where: { userId: user.id } });
      if (!centre) return [];
      where.centreId = centre.id;
    } else if (user.role === Role.DISTRICT_OFFICER) {
      where.centre = { districtId: user.districtId ?? "none" };
    }
    if (opts.status) where.status = opts.status;
    if (opts.inbox) {
      const step: Record<string, BatchStatus> = {
        CENTRE: BatchStatus.SENT_BACK,
        DISTRICT_OFFICER: BatchStatus.DISTRICT_PENDING,
        QUALITY_TEAM: BatchStatus.QUALITY_PENDING,
        STATE_OFFICE: BatchStatus.STATE_PENDING,
      };
      where.status = step[user.role];
    }

    const batches = await prisma.batch.findMany({
      where,
      include: {
        centre: { include: { district: true } },
        approvals: {
          select: { officerId: true, reviewCycle: true, role: true, decision: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    if (opts.inbox && user.role === Role.DISTRICT_OFFICER) {
      return batches.filter((b) => !b.approvals.some((a) => a.officerId === user.id && a.reviewCycle === b.reviewCycle));
    }
    return batches;
  }

  static async getBatchById(batchId: string, user: AuthenticatedUser) {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: {
        centre: { include: { district: true } },
        candidates: true,
        approvals: {
          include: { officer: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: "asc" },
        },
        certificates: true,
        auditLogs: { orderBy: { timestamp: "desc" } },
      },
    });

    if (!batch) throw new Error("Batch not found");

    // Security check: Centre can only see their own batch
    if (user.role === Role.CENTRE) {
      const centre = await prisma.trainingCentre.findFirst({ where: { userId: user.id } });
      if (batch.centreId !== centre?.id) {
        throw new Error("Forbidden: You cannot view batches from other training centres");
      }
    }

    // Security check: District officer can only see batches from their district
    if (user.role === Role.DISTRICT_OFFICER) {
      if (batch.centre.districtId !== user.districtId) {
        throw new Error("Forbidden: You cannot view batches from other districts");
      }
    }

    return batch;
  }

  /**
   * MOMENT 1: Atomic Spreadsheet Upload
   * Validates all rows strictly. If ANY row fails, returns all errors and inserts NOTHING.
   */
  static async uploadCandidates(batchId: string, centreUserId: string, fileBuffer: Buffer) {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { centre: true },
    });

    if (!batch) throw new Error("Batch not found");
    if (batch.centre.userId !== centreUserId) {
      throw new Error("Forbidden: You cannot upload candidates to another centre's batch");
    }
    if (batch.status !== BatchStatus.DRAFT && batch.status !== BatchStatus.SENT_BACK) {
      throw new Error(`Cannot upload candidates to a batch in '${batch.status}' status`);
    }

    // Parse Excel / CSV using SheetJS
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("Spreadsheet contains no sheets");
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error("Spreadsheet sheet is invalid");

    const rawRows = XLSX.utils.sheet_to_json<any>(sheet, { defval: "" });
    if (!rawRows || rawRows.length === 0) {
      throw new Error("Spreadsheet contains no data rows");
    }

    const errors: SpreadsheetValidationError[] = [];
    const validCandidates: Array<{
      fullName: string;
      phone: string;
      nationalId: string;
      score: number;
      grade: string;
    }> = [];

    const seenNationalIds = new Set<string>();

    // Validate row by row
    rawRows.forEach((row, index) => {
      const rowNumber = index + 2; // Row 1 is header
      const mapped = {
        fullName: String(row.fullName || row["Full Name"] || row.name || row["Name"] || "").trim(),
        phone: String(row.phone || row["Phone"] || row.mobile || row["Mobile"] || "").trim(),
        nationalId: String(row.nationalId || row["National ID"] || row.aadhaar || row["Aadhaar"] || "").trim(),
        score: Number(row.score ?? row["Score"] ?? row.marks ?? row["Marks"]),
        grade: String(row.grade || row["Grade"] || "").trim(),
      };

      const parseResult = CandidateRowSchema.safeParse(mapped);
      if (!parseResult.success) {
        parseResult.error.issues.forEach((issue) => {
          errors.push({
            row: rowNumber,
            field: issue.path.join(".") || "row",
            message: issue.message,
          });
        });
      } else {
        // Check for duplicate national ID within the file
        if (seenNationalIds.has(mapped.nationalId)) {
          errors.push({
            row: rowNumber,
            field: "nationalId",
            message: `Duplicate National ID '${mapped.nationalId}' found in spreadsheet`,
          });
        } else {
          seenNationalIds.add(mapped.nationalId);
        }

        const calculatedGrade =
          mapped.grade ||
          (mapped.score >= 85 ? "A" : mapped.score >= 70 ? "B" : mapped.score >= 50 ? "C" : "PASS");

        validCandidates.push({
          fullName: mapped.fullName,
          phone: mapped.phone,
          nationalId: mapped.nationalId,
          score: mapped.score,
          grade: calculatedGrade,
        });
      }
    });

    // ATOMIC GUARANTEE: If any errors exist, reject immediately without database changes
    if (errors.length > 0) {
      return {
        success: false,
        totalRows: rawRows.length,
        errorCount: errors.length,
        errors,
      };
    }

    // Atomic DB write in a single transaction
    await prisma.$transaction(async (tx) => {
      // Clear previously uploaded candidates if any
      await tx.candidate.deleteMany({ where: { batchId } });

      // Insert all validated candidates
      await tx.candidate.createMany({
        data: validCandidates.map((c) => ({
          batchId,
          fullName: c.fullName,
          phone: c.phone,
          nationalId: c.nationalId,
          score: c.score,
          grade: c.grade,
        })),
      });

      // Update batch candidate count
      await tx.batch.update({
        where: { id: batchId },
        data: {
          totalCandidates: validCandidates.length,
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: "BATCH",
          entityId: batchId,
          action: "CANDIDATES_UPLOADED",
          actorId: centreUserId,
          actorRole: Role.CENTRE,
          batchId,
          details: { count: validCandidates.length },
        },
      });
    });

    return {
      success: true,
      totalRows: validCandidates.length,
      candidateCount: validCandidates.length,
      errors: [],
    };
  }

  static async submitBatch(batchId: string, centreUserId: string) {
    const batch = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { centre: true },
    });

    if (!batch) throw new Error("Batch not found");
    if (batch.centre.userId !== centreUserId) {
      throw new Error("Forbidden: You cannot submit another centre's batch");
    }
    if (batch.status !== BatchStatus.DRAFT) {
      throw new Error(`Cannot submit batch in '${batch.status}' status`);
    }
    if (batch.totalCandidates === 0) {
      throw new Error("Cannot submit an empty batch. Upload candidates first.");
    }

        const slaDeadline = slaDeadlineFromNow();

    const updated = await prisma.batch.update({
      where: { id: batchId },
      data: {
        status: BatchStatus.DISTRICT_PENDING,
        submittedAt: new Date(),
        slaDeadline,
      },
    });

    await prisma.auditLog.create({
      data: {
        entityType: "BATCH",
        entityId: batchId,
        action: "BATCH_SUBMITTED",
        actorId: centreUserId,
        actorRole: Role.CENTRE,
        batchId,
        details: { totalCandidates: batch.totalCandidates, slaDeadline },
      },
    });

    return updated;
  }

  /**
   * MOMENT 2: Concurrency-Controlled District Officer Approval
   * Two district officers approving simultaneously moves batch forward once, not twice.
   */
  static async reviewDistrictBatch(batchId: string, officer: AuthenticatedUser, review: OfficerReviewInput) {
    if (officer.role !== Role.DISTRICT_OFFICER) {
      throw new Error("Forbidden: Only district officers can perform district review");
    }

    return prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({
        where: { id: batchId },
        include: { centre: true },
      });

      if (!batch) throw new Error("Batch not found");
      if (batch.centre.districtId !== officer.districtId) {
        throw new Error("Forbidden: You can only review batches from your assigned district");
      }
      if (batch.status !== BatchStatus.DISTRICT_PENDING) {
        throw new Error(`Batch is in '${batch.status}' status, not awaiting district approval`);
      }

      // Check if this officer already voted in this cycle
      const existingVote = await tx.batchApproval.findFirst({
        where: {
          batchId,
          officerId: officer.id,
          reviewCycle: batch.reviewCycle,
        },
      });

      if (existingVote) {
        throw new Error("You have already submitted a review for this batch in the current review cycle");
      }

      // Record the officer's review
      await tx.batchApproval.create({
        data: {
          batchId,
          officerId: officer.id,
          reviewCycle: batch.reviewCycle,
          role: Role.DISTRICT_OFFICER,
          decision: review.decision as ApprovalDecision,
          comments: review.comments,
        },
      });

      if (review.decision === ApprovalDecision.REJECTED) {
        const updated = await tx.batch.update({
          where: { id: batchId, version: batch.version },
          data: {
            status: BatchStatus.REJECTED,
            version: { increment: 1 },
          },
        });

        await tx.auditLog.create({
          data: {
            entityType: "BATCH",
            entityId: batchId,
            action: "DISTRICT_REJECTED",
            actorId: officer.id,
            actorRole: Role.DISTRICT_OFFICER,
            batchId,
            details: { comments: review.comments, cycle: batch.reviewCycle },
          },
        });

        return updated;
      }

      if (review.decision === ApprovalDecision.SENT_BACK) {
        const updated = await tx.batch.update({
          where: { id: batchId, version: batch.version },
          data: {
            status: BatchStatus.SENT_BACK,
            version: { increment: 1 },
          },
        });

        await tx.auditLog.create({
          data: {
            entityType: "BATCH",
            entityId: batchId,
            action: "DISTRICT_SENT_BACK",
            actorId: officer.id,
            actorRole: Role.DISTRICT_OFFICER,
            batchId,
            details: { reason: review.comments, cycle: batch.reviewCycle },
          },
        });

        return updated;
      }

      // Decision is APPROVED -> Check total district approvals in this review cycle
      const approvedVotes = await tx.batchApproval.count({
        where: {
          batchId,
          reviewCycle: batch.reviewCycle,
          role: Role.DISTRICT_OFFICER,
          decision: ApprovalDecision.APPROVED,
        },
      });

      let newStatus: BatchStatus = batch.status;

      // District decision requires more than one officer to agree (>= 2)
      if (approvedVotes >= 2) {
        // Large batch (> 50 candidates) scrutiny by Quality Team
        if (batch.totalCandidates > 50) {
          newStatus = BatchStatus.QUALITY_PENDING;
        } else {
          newStatus = BatchStatus.STATE_PENDING;
        }
      }

      const advanced = newStatus !== batch.status;
      const updated = await tx.batch.update({
        where: { id: batchId, version: batch.version },
        data: {
          status: newStatus,
          version: { increment: 1 },
          // Each approval step gets its own SLA clock and can be escalated once.
          ...(advanced ? { slaDeadline: slaDeadlineFromNow(), escalatedAt: null } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: "BATCH",
          entityId: batchId,
          action: "DISTRICT_APPROVED",
          actorId: officer.id,
          actorRole: Role.DISTRICT_OFFICER,
          batchId,
          details: {
            votesCount: approvedVotes,
            advanced: newStatus !== batch.status,
            newStatus,
            cycle: batch.reviewCycle,
          },
        },
      });

      return updated;
    });
  }

  /**
   * Quality Team Review (for batches > 50 candidates)
   */
  static async reviewQualityBatch(batchId: string, qualityOfficer: AuthenticatedUser, review: OfficerReviewInput) {
    if (qualityOfficer.role !== Role.QUALITY_TEAM) {
      throw new Error("Forbidden: Only Quality Team can perform quality review");
    }

    return prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new Error("Batch not found");
      if (batch.status !== BatchStatus.QUALITY_PENDING) {
        throw new Error(`Batch is in '${batch.status}' status, not awaiting quality team review`);
      }

      await tx.batchApproval.create({
        data: {
          batchId,
          officerId: qualityOfficer.id,
          reviewCycle: batch.reviewCycle,
          role: Role.QUALITY_TEAM,
          decision: review.decision as ApprovalDecision,
          comments: review.comments,
        },
      });

      let nextStatus: BatchStatus = batch.status;
      if (review.decision === ApprovalDecision.APPROVED) {
        nextStatus = BatchStatus.STATE_PENDING;
      } else if (review.decision === ApprovalDecision.SENT_BACK) {
        nextStatus = BatchStatus.SENT_BACK;
      } else {
        nextStatus = BatchStatus.REJECTED;
      }

      const updated = await tx.batch.update({
        where: { id: batchId, version: batch.version },
        data: {
          status: nextStatus,
          version: { increment: 1 },
          ...(nextStatus === BatchStatus.STATE_PENDING ? { slaDeadline: slaDeadlineFromNow(), escalatedAt: null } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: "BATCH",
          entityId: batchId,
          action: `QUALITY_${review.decision}`,
          actorId: qualityOfficer.id,
          actorRole: Role.QUALITY_TEAM,
          batchId,
          details: { comments: review.comments, newStatus: nextStatus },
        },
      });

      return updated;
    });
  }

  /**
   * State Office Final Approval & Rejection
   */
  static async reviewStateBatch(batchId: string, stateOfficer: AuthenticatedUser, review: OfficerReviewInput) {
    if (stateOfficer.role !== Role.STATE_OFFICE) {
      throw new Error("Forbidden: Only State Office can give final approval");
    }

    return prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({
        where: { id: batchId },
        include: { candidates: true },
      });
      if (!batch) throw new Error("Batch not found");
      if (batch.status !== BatchStatus.STATE_PENDING) {
        throw new Error(`Batch is in '${batch.status}' status, not awaiting state office decision`);
      }

      await tx.batchApproval.create({
        data: {
          batchId,
          officerId: stateOfficer.id,
          reviewCycle: batch.reviewCycle,
          role: Role.STATE_OFFICE,
          decision: review.decision as ApprovalDecision,
          comments: review.comments,
        },
      });

      let nextStatus: BatchStatus = batch.status;
      if (review.decision === ApprovalDecision.APPROVED) {
        nextStatus = BatchStatus.APPROVED;
      } else if (review.decision === ApprovalDecision.SENT_BACK) {
        nextStatus = BatchStatus.SENT_BACK;
      } else {
        nextStatus = BatchStatus.REJECTED;
      }

      const updated = await tx.batch.update({
        where: { id: batchId, version: batch.version },
        data: {
          status: nextStatus,
          approvedAt: review.decision === ApprovalDecision.APPROVED ? new Date() : undefined,
          version: { increment: 1 },
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: "BATCH",
          entityId: batchId,
          action: `STATE_${review.decision}`,
          actorId: stateOfficer.id,
          actorRole: Role.STATE_OFFICE,
          batchId,
          details: { comments: review.comments, newStatus: nextStatus },
        },
      });

      return updated;
    });
  }

  /**
   * MOMENT 6: Resubmission Lifecycle
   * Resubmission resets prior approvals for current cycle, increments reviewCycle,
   * sets status back to DISTRICT_PENDING, and logs deliberate decision.
   */
  static async resubmitBatch(batchId: string, centreUserId: string) {
    return prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findUnique({
        where: { id: batchId },
        include: { centre: true },
      });

      if (!batch) throw new Error("Batch not found");
      if (batch.centre.userId !== centreUserId) {
        throw new Error("Forbidden: You cannot resubmit another centre's batch");
      }
      if (batch.status !== BatchStatus.SENT_BACK) {
        throw new Error(`Cannot resubmit batch in '${batch.status}' status. Only SENT_BACK batches can be resubmitted.`);
      }

      const newCycle = batch.reviewCycle + 1;
      const slaDeadline = slaDeadlineFromNow();

      const updated = await tx.batch.update({
        where: { id: batchId },
        data: {
          status: BatchStatus.DISTRICT_PENDING,
          reviewCycle: newCycle,
          slaDeadline,
          escalatedAt: null,
          version: { increment: 1 },
        },
      });

      await tx.auditLog.create({
        data: {
          entityType: "BATCH",
          entityId: batchId,
          action: "BATCH_RESUBMITTED",
          actorId: centreUserId,
          actorRole: Role.CENTRE,
          batchId,
          details: {
            previousCycle: batch.reviewCycle,
            newCycle,
            policy: "All previous cycle approvals reset. Full multi-officer district re-approval required.",
          },
        },
      });

      return updated;
    });
  }
}
