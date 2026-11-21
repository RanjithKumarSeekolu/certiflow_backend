import prisma from "../config/db";
import { BatchStatus, Role } from "@prisma/client";
import { emitBatchEvent } from "../realtime/events";

export interface SlaBreachReport {
  batchId: string;
  batchNumber: string;
  centreName: string;
  status: BatchStatus;
  submittedAt: Date | null;
  slaDeadline: Date | null;
  overdueMinutes: number;
  escalatedAt: Date | null;
}

const PENDING: BatchStatus[] = [BatchStatus.DISTRICT_PENDING, BatchStatus.QUALITY_PENDING, BatchStatus.STATE_PENDING];

export class SlaMonitorWorker {
  /** Read-only: every batch currently past its deadline at its current step. */
  public static async listBreached(): Promise<SlaBreachReport[]> {
    const now = new Date();
    const batches = await prisma.batch.findMany({
      where: { status: { in: PENDING }, slaDeadline: { lt: now } },
      include: { centre: true },
      orderBy: { slaDeadline: "asc" },
    });
    return batches.map((b) => ({
      batchId: b.id,
      batchNumber: b.batchNumber,
      centreName: b.centre.name,
      status: b.status,
      submittedAt: b.submittedAt,
      slaDeadline: b.slaDeadline,
      overdueMinutes: Math.round((now.getTime() - b.slaDeadline!.getTime()) / 60000),
      escalatedAt: b.escalatedAt,
    }));
  }

  /**
   * Escalates each newly breached step exactly once (escalatedAt is claimed atomically, so two
   * workers scanning at once cannot both escalate). The clock restarts when the batch changes step.
   */
  public static async scanAndEscalateBreaches(): Promise<SlaBreachReport[]> {
    const escalated: SlaBreachReport[] = [];
    for (const report of await this.listBreached()) {
      if (report.escalatedAt) continue;
      const won = await prisma.$transaction(async (tx) => {
        const claim = await tx.batch.updateMany({
          where: { id: report.batchId, status: report.status, escalatedAt: null },
          data: { escalatedAt: new Date() },
        });
        if (claim.count === 0) return false;
        await tx.auditLog.create({
          data: {
            entityType: "BATCH",
            entityId: report.batchId,
            action: "SLA_BREACH_ESCALATED",
            actorRole: Role.STATE_OFFICE,
            batchId: report.batchId,
            details: {
              batchNumber: report.batchNumber,
              status: report.status,
              overdueMinutes: report.overdueMinutes,
              slaDeadline: report.slaDeadline,
              escalatedTo: "State Office",
            },
          },
        });
        return true;
      });
      if (won) {
        escalated.push(report);
        await emitBatchEvent(report.batchId, "batch.sla_breached");
      }
    }
    return escalated;
  }
}
