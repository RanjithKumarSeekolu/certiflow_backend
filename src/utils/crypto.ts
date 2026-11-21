import crypto from "crypto";
import { jwtSecret } from "../config/env";

export function generateCertificateNumber(): string {
  const year = new Date().getFullYear();
  const randomHex = crypto.randomBytes(8).toString("hex").toUpperCase();
  return `CERT-${year}-${randomHex}`;
}

export function generateVerificationHash(data: {
  candidateId: string;
  candidateName: string;
  nationalId: string;
  courseName: string;
  score: number;
  grade: string;
  batchId: string;
  issuedAt: Date;
}): string {
  const payload = [
    data.candidateId,
    data.candidateName,
    data.nationalId,
    data.courseName,
    data.score.toFixed(2),
    data.grade,
    data.batchId,
    data.issuedAt.toISOString(),
  ].join("|");

  return crypto.createHash("sha256").update(payload).digest("hex");
}


// Signed, expiring download links: candidates have no login, so the link itself is the credential.
function downloadSignature(certificateId: string, exp: number): string {
  return crypto.createHmac("sha256", jwtSecret()).update(`download:${certificateId}:${exp}`).digest("hex");
}

export function signDownloadToken(certificateId: string, ttlSeconds = 7 * 24 * 60 * 60): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${downloadSignature(certificateId, exp)}`;
}

export function verifyDownloadToken(certificateId: string, token: string): boolean {
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!sig || !Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(downloadSignature(certificateId, exp));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
