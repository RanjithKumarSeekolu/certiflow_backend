import { Router, Request, Response, NextFunction } from "express";
import { CertificateController } from "../certificates/certificate.controller";
import { allowRequest } from "../../config/redis";

const router = Router();

async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 60 lookups/minute per client IP; the limit is shared across API instances via Redis.
  if (await allowRequest(`rl:verify:${req.ip}`, 60, 60)) return next();
  res.status(429).json({ error: "Too many verification requests. Try again shortly." });
}

// Public Verification Endpoint (No authentication required)
router.get("/:identifier", rateLimit, CertificateController.verify);

export default router;
