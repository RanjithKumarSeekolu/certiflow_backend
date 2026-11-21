import { Router } from "express";
import { CertificateController } from "./certificate.controller";
import { authenticate, requireRole } from "../../middlewares/auth.middleware";

const router = Router();

// Public, but only with a valid signed link (sent to the candidate on WhatsApp)
router.get("/:id/download", CertificateController.download);

// Protected endpoints
router.post("/batch/:batchId/issue", authenticate, requireRole("STATE_OFFICE"), CertificateController.issueForBatch);
router.post("/:id/revoke", authenticate, requireRole("STATE_OFFICE"), CertificateController.revoke);

export default router;

