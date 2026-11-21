import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { app, prisma, request, as, review, wipeBatches, submittedBatch, tokenForUser, loadTokens } from "./helpers";
import { redis } from "../src/config/redis";

beforeAll(loadTokens);
beforeEach(wipeBatches);
afterAll(async () => {
  await wipeBatches();
  await prisma.user.deleteMany({ where: { email: "outsider@test.local" } });
  redis.disconnect();
  await prisma.$disconnect();
});

describe("Never: acting at a step or as a person that is not yours", () => {
  it("rejects missing, forged and wrong-secret tokens", async () => {
    expect((await request(app).get("/api/batches")).status).toBe(401);
    expect((await request(app).get("/api/batches").set("Authorization", "Bearer nonsense")).status).toBe(401);
    const forged = tokenForUser({ id: "x", email: "x@x", role: "STATE_OFFICE", districtId: null, name: "x" }).slice(0, -3) + "abc";
    expect((await request(app).get("/api/batches").set("Authorization", `Bearer ${forged}`)).status).toBe(401);
  });

  it("blocks the wrong role at each step", async () => {
    const id = await submittedBatch(3);
    expect((await review("anika", id, "district", "APPROVED")).status).toBe(403);
    expect((await review("farah", id, "district", "APPROVED")).status).toBe(403);
    expect((await review("dev", id, "state", "APPROVED")).status).toBe(403);
    expect((await review("dev", id, "quality", "APPROVED")).status).toBe(403);
    expect((await as("dev", "post", `/api/batches/${id}/submit`).send()).status).toBe(403);
  });

  it("blocks the right role at the wrong step", async () => {
    const id = await submittedBatch(3);
    const res = await review("farah", id, "state", "APPROVED"); // batch is still at district
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.batch.findUnique({ where: { id } }))!.status).toBe("DISTRICT_PENDING");
  });

  it("blocks a district officer from another district", async () => {
    const id = await submittedBatch(3);
    const north = await prisma.district.findUniqueOrThrow({ where: { code: "DIST-02" } });
    const outsider = await prisma.user.upsert({
      where: { email: "outsider@test.local" },
      update: {},
      create: { name: "Outsider", email: "outsider@test.local", passwordHash: "x", role: "DISTRICT_OFFICER", districtId: north.id },
    });
    const token = tokenForUser({ id: outsider.id, email: outsider.email, role: outsider.role, districtId: north.id, name: outsider.name });
    const res = await request(app).post(`/api/batches/${id}/district-review`).set("Authorization", `Bearer ${token}`).send({ decision: "APPROVED" });
    expect(res.status).toBe(403);
    expect((await request(app).get(`/api/batches/${id}`).set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("demo-login is off unless DEMO_MODE=true", async () => {
    process.env.DEMO_MODE = "false";
    try {
      expect((await request(app).post("/api/auth/demo-login").send({ persona: "farah" })).status).toBe(404);
    } finally {
      process.env.DEMO_MODE = "true";
    }
  });
});

describe("Never: a stranger gets personal data", () => {
  it("rate-limits public verification", async () => {
    const keys = await redis.keys("rl:verify:*");
    if (keys.length) await redis.del(...keys);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await request(app).get("/api/verify/CERT-2026-NOPE")).status;
    expect(last).toBe(429);
    const k2 = await redis.keys("rl:verify:*");
    if (k2.length) await redis.del(...k2);
  });
});
