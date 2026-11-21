import { describe, it, expect, afterAll } from "vitest";
import { app, request, prisma } from "./helpers";
import { openapi } from "../src/docs/openapi";
import { redis } from "../src/config/redis";

afterAll(async () => {
  redis.disconnect();
  await prisma.$disconnect();
});

const FAKE_ID = "00000000-0000-0000-0000-000000000000";
type Op = { security?: unknown[]; responses: Record<string, unknown> };
const operations = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, Op>).map(([method, op]) => ({ path, method, op }))
);

describe("API docs", () => {
  it("serves Swagger UI and the raw spec", async () => {
    expect((await request(app).get("/api/docs/")).status).toBe(200);
    const spec = await request(app).get("/api/docs.json");
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\./);
  });

  it("documents all 20 endpoints", () => {
    expect(operations).toHaveLength(20);
  });

  it("every documented response schema reference exists", () => {
    const text = JSON.stringify(openapi);
    const refs = [...text.matchAll(/#\/components\/(schemas|responses)\/(\w+)/g)];
    const c = openapi.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs) expect(c[kind!]![name!], `${kind}/${name}`).toBeDefined();
  });

  it("security in the spec matches the app: secured endpoints refuse anonymous callers, public ones don't", async () => {
    for (const { path, method, op } of operations) {
      const url = path.replace(/\{[^}]+\}/g, FAKE_ID).replace(/\/download$/, "/download?token=x");
      const res = await (request(app) as any)[method](url).send({});
      if (op.security) expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      else expect(res.status, `${method.toUpperCase()} ${path}`).not.toBe(401);
    }
  });
});
