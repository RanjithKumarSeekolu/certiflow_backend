import { Response } from "express";
import { BatchService } from "./batch.service";
import { CreateBatchSchema, OfficerReviewSchema } from "./batch.schema";
import { AuthRequest } from "../../middlewares/auth.middleware";
import { SlaMonitorWorker } from "../../workers/sla.worker";
import { Prisma, BatchStatus } from "@prisma/client";
import { emitBatchEvent } from "../../realtime/events";
import { publish } from "../../queues/broker";
import { Q } from "../../queues/queue-names";

// Races on a batch surface as Prisma conflicts: tell the client to retry instead of leaking internals.
function reviewError(res: Response, err: any): void {
  if (err instanceof Prisma.PrismaClientKnownRequestError && ["P2025", "P2002", "P2034"].includes(err.code)) {
    res.status(409).json({ error: "Another decision was recorded at the same time. Refresh and retry." });
    return;
  }
  res.status(String(err?.message).includes("Forbidden") ? 403 : 400).json({ error: err?.message ?? "Request failed" });
}

export class BatchController {
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      const parsed = CreateBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }
      const batch = await BatchService.createBatch(req.user!.id, parsed.data.courseName);
      res.status(201).json(batch);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      const status = String(req.query.status ?? "");
      if (status && !(status in BatchStatus)) {
        res.status(400).json({ error: `Unknown status. Valid: ${Object.keys(BatchStatus).join(", ")}` });
        return;
      }
      const batches = await BatchService.getBatches(req.user!, {
        inbox: req.query.inbox === "true",
        status: status ? (status as BatchStatus) : undefined,
      });
      res.json(batches);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const batch = await BatchService.getBatchById(id, req.user!);
      res.json(batch);
    } catch (err: any) {
      const status = err.message.includes("Forbidden") ? 403 : err.message.includes("not found") ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }

  static async uploadCandidates(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: "No file uploaded. Please upload a .xlsx, .xls, or .csv file." });
        return;
      }

      const result = await BatchService.uploadCandidates(id, req.user!.id, req.file.buffer);

      if (!result.success) {
        res.status(422).json(result);
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async submit(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const batch = await BatchService.submitBatch(id, req.user!.id);
      void emitBatchEvent(id, "batch.updated");
      res.json(batch);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async districtReview(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const parsed = OfficerReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }
      const updated = await BatchService.reviewDistrictBatch(id, req.user!, parsed.data);
      void emitBatchEvent(id, "batch.updated");
      res.json(updated);
    } catch (err: any) {
      reviewError(res, err);
    }
  }

  static async qualityReview(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const parsed = OfficerReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }
      const updated = await BatchService.reviewQualityBatch(id, req.user!, parsed.data);
      void emitBatchEvent(id, "batch.updated");
      res.json(updated);
    } catch (err: any) {
      reviewError(res, err);
    }
  }

  static async stateReview(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const parsed = OfficerReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
        return;
      }
      const updated = await BatchService.reviewStateBatch(id, req.user!, parsed.data);
      void emitBatchEvent(id, "batch.updated");
      if (updated.status === "APPROVED") {
        // Hand off to the worker. If the broker is down the worker's sweeper picks the batch up later.
        publish(Q.issue, { batchId: id }).catch((e) => console.error(`[queue] enqueue failed for ${id}: ${e.message}`));
      }
      res.json(updated);
    } catch (err: any) {
      reviewError(res, err);
    }
  }

  static async resubmit(req: AuthRequest, res: Response): Promise<void> {
    try {
      const id = String(req.params.id);
      const batch = await BatchService.resubmitBatch(id, req.user!.id);
      void emitBatchEvent(id, "batch.updated");
      res.json(batch);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async getStuckBatches(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const breaches = await SlaMonitorWorker.listBreached();
      res.json(breaches);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}
