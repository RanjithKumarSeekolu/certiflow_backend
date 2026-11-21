import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prisma, as, review, submittedBatch, loadTokens, wipeBatches } from "./helpers";

beforeAll(loadTokens);
beforeEach(wipeBatches);
afterAll(async () => {
  await wipeBatches();
  await prisma.$disconnect();
});

const ids = (res: { body: Array<{ id: string }> }) => res.body.map((b) => b.id);

describe("Officers can see what is waiting for them", () => {
  it("district inbox shrinks per officer as they vote; later steps appear in the right inbox", async () => {
    const id = await submittedBatch(3);

    expect(ids(await as("dev", "get", "/api/batches?inbox=true").send())).toContain(id);
    expect(ids(await as("farah", "get", "/api/batches?inbox=true").send())).not.toContain(id);

    await review("dev", id, "district", "APPROVED");
    expect(ids(await as("dev", "get", "/api/batches?inbox=true").send())).not.toContain(id); // Dev already voted
    expect(ids(await as("meera", "get", "/api/batches?inbox=true").send())).toContain(id);

    await review("meera", id, "district", "APPROVED");
    expect(ids(await as("meera", "get", "/api/batches?inbox=true").send())).not.toContain(id);
    expect(ids(await as("farah", "get", "/api/batches?inbox=true").send())).toContain(id);
  });

  it("a sent-back batch lands in the centre's inbox, and old votes don't hide it in the new cycle", async () => {
    const id = await submittedBatch(3);
    await review("dev", id, "district", "SENT_BACK", "fix numbers");
    expect(ids(await as("anika", "get", "/api/batches?inbox=true").send())).toContain(id);

    await as("anika", "post", `/api/batches/${id}/resubmit`).send();
    expect(ids(await as("dev", "get", "/api/batches?inbox=true").send())).toContain(id); // new cycle: Dev can vote again
  });

  it("rejects an unknown status filter", async () => {
    expect((await as("farah", "get", "/api/batches?status=NOPE").send()).status).toBe(400);
  });
});

describe("Never: a stranger gets personal details", () => {
  it("list and detail never expose password hashes, and the list carries no candidate rows", async () => {
    const id = await submittedBatch(3);
    await review("dev", id, "district", "APPROVED");

    for (const who of ["anika", "dev", "neha", "farah"] as const) {
      const list = await as(who, "get", "/api/batches").send();
      expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|nationalId|\"phone\"/);
    }
    const detail = await as("dev", "get", `/api/batches/${id}`).send();
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain("passwordHash");
    expect(detail.body.approvals[0].officer).toEqual({ id: expect.any(String), name: "Dev Patel", role: "DISTRICT_OFFICER" });
  });
});
