import { Router } from "express";
import multer from "multer";
import { BatchController } from "./batch.controller";
import { authenticate, requireRole } from "../../middlewares/auth.middleware";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = Router();

router.use(authenticate);

// List & Get
router.get("/stuck", requireRole("STATE_OFFICE"), BatchController.getStuckBatches);
router.get("/", BatchController.list);
router.get("/:id", BatchController.getById);

// Centre actions
router.post("/", requireRole("CENTRE"), BatchController.create);
router.post("/:id/upload", requireRole("CENTRE"), upload.single("file"), BatchController.uploadCandidates);
router.post("/:id/submit", requireRole("CENTRE"), BatchController.submit);
router.post("/:id/resubmit", requireRole("CENTRE"), BatchController.resubmit);

// Review actions
router.post("/:id/district-review", requireRole("DISTRICT_OFFICER"), BatchController.districtReview);
router.post("/:id/quality-review", requireRole("QUALITY_TEAM"), BatchController.qualityReview);
router.post("/:id/state-review", requireRole("STATE_OFFICE"), BatchController.stateReview);

export default router;
