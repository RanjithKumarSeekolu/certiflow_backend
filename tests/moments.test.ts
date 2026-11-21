import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  app, prisma, request, as, review, sheet, goodRows, wipeBatches,
  submittedBatch, approvedBatch, loadTokens, waitFor, waitDelivered,
} from "./helpers";
import { startWorkers } from "../src/workers/runner";
import { purgeAll, closePublisher, deadLetterCount } from "../src/queues/broker";
import { Q } from "../src/queues/queue-names";
import { SlaMonitorWorker } from "../src/workers/sla.worker";
import { StandinWhatsAppProvider } from "../src/integrations/whatsapp-provider";
import { signDownloadToken } from "../src/utils/crypto";

let workers: { stop(): Promise<void> };
beforeAll(async () => {
  await loadTokens();
  workers = await startWorkers();
});
beforeEach(async () => {
  await purgeAll(); // drop messages left over from the previous test
  await wipeBatches();
  StandinWhatsAppProvider.reset();
  StandinWhatsAppProvider.failureRate = 0.35;
  StandinWhatsAppProvider.timeoutAfterDeliveryRate = 0.1;
});
afterAll(async () => {
  await workers.stop();
  await purgeAll();
  await closePublisher();
  await wipeBatches();
  await prisma.$disconnect();
});

describe("Moment 1: bad spreadsheet rows, nothing half-saved", () => {
  it("reports every bad row and saves no candidates", async () => {
    const created = await as("anika", "post", "/api/batches").send({ courseName: "Welding Level 2" });
    const id = created.body.id as string;
    const rows = goodRows(5);
    rows[1] = { ...rows[1]!, phone: "123" }; // sheet row 3
    rows[2] = { ...rows[2]!, fullName: "" }; // sheet row 4
    rows[4] = { ...rows[4]!, score: 150 }; // sheet row 6

    const res = await as("anika", "post", `/api/batches/${id}/upload`).attach("file", sheet(rows), "c.xlsx");

    expect(res.status).toBe(422);
    const badRows = new Set(res.body.errors.map((e: { row: number }) => e.row));
    expect(badRows).toEqual(new Set([3, 4, 6]));
    expect(await prisma.candidate.count({ where: { batchId: id } })).toBe(0);
    expect((await prisma.batch.findUnique({ where: { id } }))!.totalCandidates).toBe(0);
  });
});

describe("Moment 2: concurrent officer approvals advance the batch once", () => {
  it("never advances twice, records one vote per officer, and converges after retries", async () => {
    const id = await submittedBatch(5);

    const results = await Promise.all(
      (["dev", "meera", "kabir"] as const).map((p) => review(p, id, "district", "APPROVED"))
    );
    // Whoever lost the race is told to retry (409), never a 500 or a silent drop.
    for (const [i, p] of (["dev", "meera", "kabir"] as const).entries()) {
      if (results[i]!.status !== 200) {
        expect(results[i]!.status).toBe(409);
        const batch = await prisma.batch.findUnique({ where: { id } });
        if (batch!.status === "DISTRICT_PENDING") await review(p, id, "district", "APPROVED");
      }
    }

    const batch = await prisma.batch.findUnique({ where: { id } });
    expect(batch!.status).toBe("STATE_PENDING");
    const votes = await prisma.batchApproval.findMany({ where: { batchId: id } });
    expect(new Set(votes.map((v) => v.officerId)).size).toBe(votes.length); // one vote per officer
    const advanced = (await prisma.auditLog.findMany({ where: { batchId: id, action: "DISTRICT_APPROVED" } })).filter(
      (a) => (a.details as { advanced?: boolean }).advanced
    );
    expect(advanced).toHaveLength(1);
  });

  it("needs two distinct officers: one approval is not enough", async () => {
    const id = await submittedBatch(3);
    await review("dev", id, "district", "APPROVED");
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("DISTRICT_PENDING");
    const again = await review("dev", id, "district", "APPROVED"); // same officer cannot vote twice
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("DISTRICT_PENDING");
  });
});

describe("Moment 3: 60 candidates, flaky WhatsApp, exactly one certificate and message each", () => {
  it("approval alone triggers issuance; a worker restart midway loses nothing and duplicates nothing", async () => {
    const id = await approvedBatch(60); // >50 => district x2, quality, state. No manual issue call.

    await waitFor(async () => (await prisma.deliveryJob.count({ where: { status: "COMPLETED" } })) >= 15, 40_000, "some deliveries");
    await workers.stop(); // crash the workers mid-run (unacked messages go back to the queue)
    workers = await startWorkers();
    await waitDelivered(id, 60);

    const certs = await prisma.certificate.findMany({ where: { batchId: id } });
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.certificateNumber)).size).toBe(60);
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);
    expect(certs.every((c) => c.pdfUrl)).toBe(true);
    const jobs = await prisma.deliveryJob.findMany();
    expect(jobs).toHaveLength(60);
    expect(jobs.every((j) => j.status === "COMPLETED")).toBe(true);
    // Every message reached the "phone" exactly once, despite failures, timeouts-after-delivery and the restart.
    const sends = StandinWhatsAppProvider.getSendCounts();
    expect(sends.size).toBe(60);
    expect([...sends.values()].every((n) => n === 1)).toBe(true);
  });

  it("recovers when the enqueue message is lost (sweeper)", async () => {
    const id = await approvedBatch(3);
    await purgeAll(); // simulate the broker losing the batch.issue message
    await waitDelivered(id, 3);
    expect(await prisma.certificate.count({ where: { batchId: id } })).toBe(3);
  });

  it("dead-letters an exhausted delivery, marks it FAILED, and an operator re-trigger re-drives it", async () => {
    process.env.QUEUE_MAX_ATTEMPTS = "2";
    StandinWhatsAppProvider.failureRate = 1;
    try {
      const id = await approvedBatch(2);
      await waitFor(async () => (await prisma.deliveryJob.count({ where: { status: "FAILED" } })) === 2, 30_000, "FAILED jobs");
      expect(await deadLetterCount(Q.deliver)).toBe(2);

      StandinWhatsAppProvider.failureRate = 0;
      process.env.QUEUE_MAX_ATTEMPTS = "12";
      const re = await as("farah", "post", `/api/certificates/batch/${id}/issue`).send();
      expect(re.status).toBe(202);
      await waitDelivered(id, 2);
    } finally {
      process.env.QUEUE_MAX_ATTEMPTS = "12";
    }
  });

  it("refuses to issue for a batch that is not approved", async () => {
    const id = await submittedBatch(3);
    const res = await as("farah", "post", `/api/certificates/batch/${id}/issue`).send();
    expect(res.status).toBe(409);
    expect(await prisma.certificate.count()).toBe(0);
  });
});

describe("Moment 4: cancel a certificate, verification reflects it immediately", () => {
  async function issueOne() {
    StandinWhatsAppProvider.failureRate = 0;
    const id = await approvedBatch(3);
    await waitDelivered(id, 3);
    return (await prisma.certificate.findFirstOrThrow({ where: { batchId: id }, include: { candidate: true } }));
  }

  it("verifies valid, masks the name, then reports revoked at once", async () => {
    const cert = await issueOne();

    const ok = await request(app).get(`/api/verify/${cert.certificateNumber}`);
    expect(ok.status).toBe(200);
    expect(ok.body.valid).toBe(true);
    expect(ok.body.candidateName).not.toContain(cert.candidate.fullName.split(" ")[0]);
    expect(ok.body).not.toHaveProperty("pdfUrl");
    expect(ok.body).not.toHaveProperty("verificationHash");
    expect(ok.body).not.toHaveProperty("score");

    const rev = await as("farah", "post", `/api/certificates/${cert.id}/revoke`).send({ reason: "Forged marksheet" });
    expect(rev.status).toBe(200);

    const after = await request(app).get(`/api/verify/${cert.certificateNumber}`);
    expect(after.body.valid).toBe(false);
    expect(after.body.status).toBe("REVOKED");
    expect(await prisma.auditLog.count({ where: { entityId: cert.id, action: "CERTIFICATE_REVOKED" } })).toBe(1);

    const again = await as("farah", "post", `/api/certificates/${cert.id}/revoke`).send({ reason: "again" });
    expect(again.status).toBe(409);
  });

  it("only the state office can revoke", async () => {
    const cert = await issueOne();
    for (const p of ["anika", "dev", "neha"] as const) {
      const res = await as(p, "post", `/api/certificates/${cert.id}/revoke`).send({ reason: "x" });
      expect(res.status).toBe(403);
    }
    expect((await request(app).get(`/api/verify/${cert.certificateNumber}`)).body.valid).toBe(true);
  });

  it("serves the PDF only through a valid signed link, and not after cancellation", async () => {
    const cert = await issueOne();
    const good = signDownloadToken(cert.id);

    const ok = await request(app).get(`/api/certificates/${cert.id}/download?token=${good}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("pdf");

    expect((await request(app).get(`/api/certificates/${cert.id}/download`)).status).toBe(403);
    expect((await request(app).get(`/api/certificates/${cert.id}/download?token=${good}x`)).status).toBe(403);
    expect((await request(app).get(`/api/certificates/${cert.id}/download?token=1.${"0".repeat(64)}`)).status).toBe(403);
    const other = signDownloadToken("some-other-certificate-id");
    expect((await request(app).get(`/api/certificates/${cert.id}/download?token=${other}`)).status).toBe(403);
    // The old public static route is gone.
    expect((await request(app).get(`/certificates/${cert.certificateNumber}.pdf`)).status).toBe(404);

    await as("farah", "post", `/api/certificates/${cert.id}/revoke`).send({ reason: "fake" });
    expect((await request(app).get(`/api/certificates/${cert.id}/download?token=${good}`)).status).toBe(410);
  });

  it("returns 404 for an unknown certificate", async () => {
    const res = await request(app).get("/api/verify/CERT-2026-DOESNOTEXIST");
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
  });
});

describe("Moment 5: a batch stuck past its SLA is escalated without chasing", () => {
  it("escalates once per step even if scanned repeatedly or concurrently; /stuck is read-only", async () => {
    const id = await submittedBatch(3);
    await prisma.batch.update({ where: { id }, data: { slaDeadline: new Date(Date.now() - 3 * 3600 * 1000) } });

    const stuck = await as("farah", "get", "/api/batches/stuck").send();
    expect(stuck.body.map((b: { batchId: string }) => b.batchId)).toContain(id);
    expect(await prisma.auditLog.count({ where: { batchId: id, action: "SLA_BREACH_ESCALATED" } })).toBe(0);

    await Promise.all([SlaMonitorWorker.scanAndEscalateBreaches(), SlaMonitorWorker.scanAndEscalateBreaches()]);
    await SlaMonitorWorker.scanAndEscalateBreaches();
    expect(await prisma.auditLog.count({ where: { batchId: id, action: "SLA_BREACH_ESCALATED" } })).toBe(1);
  });

  it("gives each approval step its own clock and re-arms escalation", async () => {
    const id = await submittedBatch(3);
    await prisma.batch.update({ where: { id }, data: { slaDeadline: new Date(Date.now() - 3600 * 1000) } });
    await SlaMonitorWorker.scanAndEscalateBreaches();

    await review("dev", id, "district", "APPROVED");
    await review("meera", id, "district", "APPROVED"); // -> STATE_PENDING: new step, new clock
    const b = await prisma.batch.findUniqueOrThrow({ where: { id } });
    expect(b.status).toBe("STATE_PENDING");
    expect(b.slaDeadline!.getTime()).toBeGreaterThan(Date.now());
    expect(b.escalatedAt).toBeNull();
  });
});

describe("Moment 6: send back, resubmit, earlier approvals no longer count", () => {
  it("requires two fresh district approvals in the new review cycle", async () => {
    const id = await submittedBatch(3);
    await review("dev", id, "district", "APPROVED"); // cycle 1 vote
    await review("meera", id, "district", "SENT_BACK", "fix phone numbers");
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("SENT_BACK");

    const re = await as("anika", "post", `/api/batches/${id}/resubmit`).send();
    expect(re.status).toBe(200);
    expect((await prisma.batch.findUnique({ where: { id } }))!.reviewCycle).toBe(2);

    await review("dev", id, "district", "APPROVED"); // Dev's cycle-1 approval must not count
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("DISTRICT_PENDING");
    await review("kabir", id, "district", "APPROVED");
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("STATE_PENDING");
    // History is kept.
    expect(await prisma.batchApproval.count({ where: { batchId: id, reviewCycle: 1 } })).toBe(2);
  });
});
