import { Request, Response } from "express";
import { CertificateService, CertificateError } from "./certificate.service";
import { AuthRequest } from "../../middlewares/auth.middleware";

function fail(res: Response, err: unknown): void {
  if (err instanceof CertificateError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

export class CertificateController {
  static async issueForBatch(req: AuthRequest, res: Response): Promise<void> {
    try {
      res.status(202).json(await CertificateService.requeueBatch(String(req.params.batchId)));
    } catch (err) {
      fail(res, err);
    }
  }

  static async revoke(req: AuthRequest, res: Response): Promise<void> {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason) {
        res.status(400).json({ error: "Revocation reason is required" });
        return;
      }
      res.json(await CertificateService.revokeCertificate(String(req.params.id), reason, req.user!.id));
    } catch (err) {
      fail(res, err);
    }
  }

  static async verify(req: Request, res: Response): Promise<void> {
    try {
      const result = await CertificateService.verifyCertificate(String(req.params.identifier));
      res.set("Cache-Control", "no-store"); // never let a proxy/CDN serve a stale validity answer
      res.status(result.status === "NOT_FOUND" ? 404 : 200).json(result);
    } catch (err) {
      fail(res, err);
    }
  }

  static async downloadLink(req: AuthRequest, res: Response): Promise<void> {
    try {
      res.json(await CertificateService.createDownloadLink(String(req.params.id), req.user!));
    } catch (err) {
      fail(res, err);
    }
  }

  static async download(req: Request, res: Response): Promise<void> {
    try {
      const { filePath, fileName } = await CertificateService.resolveDownload(String(req.params.id), String(req.query.token ?? ""));
      res.download(filePath, fileName, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "Certificate file not available" });
      });
    } catch (err) {
      fail(res, err);
    }
  }
}
