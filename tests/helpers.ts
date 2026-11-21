import request from "supertest";
import * as XLSX from "xlsx";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/config/db";

export { app, prisma, request };

export type Persona = "anika" | "dev" | "meera" | "kabir" | "neha" | "farah";

const tokens = new Map<Persona, string>();
export async function tokenFor(persona: Persona): Promise<string> {
  let t = tokens.get(persona);
  if (!t) {
    const res = await request(app).post("/api/auth/demo-login").send({ persona });
    if (res.status !== 200) throw new Error(`demo-login failed for ${persona}: ${res.status}`);
    t = res.body.token as string;
    tokens.set(persona, t);
  }
  return t;
}

// Synchronous on purpose: a supertest request is thenable, so returning it from an async fn would fire it.
export function as(persona: Persona, method: "get" | "post", url: string) {
  const t = tokens.get(persona);
  if (!t) throw new Error(`call loadTokens() first (missing ${persona})`);
  return request(app)[method](url).set("Authorization", `Bearer ${t}`);
}

export async function loadTokens() {
  for (const p of ["anika", "dev", "meera", "kabir", "neha", "farah"] as Persona[]) await tokenFor(p);
}

export function sheet(rows: Array<Record<string, unknown>>): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Candidates");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function goodRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    fullName: `Candidate Number${i}`,
    phone: `98${String(10000000 + i)}`,
    nationalId: `NID-${Date.now()}-${i}`,
    score: 60 + (i % 40),
  }));
}

export async function wipeBatches() {
  await prisma.deliveryJob.deleteMany();
  await prisma.certificate.deleteMany();
  await prisma.batchApproval.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.batch.deleteMany();
}

/** Anika creates a batch, uploads n candidates and submits it (DISTRICT_PENDING). */
export async function submittedBatch(n: number): Promise<string> {
  const created = await as("anika", "post", "/api/batches").send({ courseName: "Welding Level 2" });
  const id = created.body.id as string;
  const up = await as("anika", "post", `/api/batches/${id}/upload`).attach("file", sheet(goodRows(n)), "c.xlsx");
  if (up.status !== 200) throw new Error(`upload failed: ${JSON.stringify(up.body)}`);
  const sub = await as("anika", "post", `/api/batches/${id}/submit`).send();
  if (sub.status !== 200) throw new Error(`submit failed: ${JSON.stringify(sub.body)}`);
  return id;
}

export async function review(persona: Persona, id: string, step: "district" | "quality" | "state", decision: string, comments?: string) {
  return as(persona, "post", `/api/batches/${id}/${step}-review`).send({ decision, comments });
}

/** Drives a batch through every required approval to APPROVED. */
export async function approvedBatch(n: number): Promise<string> {
  const id = await submittedBatch(n);
  await review("dev", id, "district", "APPROVED");
  await review("meera", id, "district", "APPROVED");
  if (n > 50) await review("neha", id, "quality", "APPROVED");
  const fin = await review("farah", id, "state", "APPROVED");
  if (fin.status !== 200) throw new Error(`state approval failed: ${JSON.stringify(fin.body)}`);
  return id;
}

export function tokenForUser(user: { id: string; email: string; role: string; districtId: string | null; name: string }) {
  return jwt.sign(user, process.env.JWT_SECRET!);
}

export async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 40_000, what = "condition"): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Resolves when every candidate of the batch has a COMPLETED delivery job. */
export async function waitDelivered(batchId: string, expected: number) {
  await waitFor(async () => {
    const done = await prisma.deliveryJob.count({ where: { certificate: { batchId }, status: "COMPLETED" } });
    return done === expected;
  }, 60_000, `${expected} deliveries`);
}
