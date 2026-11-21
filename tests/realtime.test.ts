import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { io as connect, Socket } from "socket.io-client";
import { app, prisma, review, submittedBatch, loadTokens, tokenFor, tokenForUser, wipeBatches } from "./helpers";
import { initSocketIO, getIO } from "../src/realtime/socket";
import { startEventForwarder } from "../src/realtime/events";
import { redis } from "../src/config/redis";

let server: http.Server;
let url: string;
let forwarder: ReturnType<typeof startEventForwarder>;
const open: Socket[] = [];

async function client(token?: string): Promise<Socket> {
  const s = connect(url, { auth: token ? { token } : {}, transports: ["websocket"], reconnection: false });
  open.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once("connect", () => resolve());
    s.once("connect_error", (e) => reject(e));
  });
  return s;
}

function collect(s: Socket, type: string): Array<{ batchId: string; status: string }> {
  const got: Array<{ batchId: string; status: string }> = [];
  s.on(type, (p) => got.push(p));
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 600));

beforeAll(async () => {
  await loadTokens();
  server = http.createServer(app);
  initSocketIO(server);
  forwarder = startEventForwarder();
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  await new Promise((r) => setTimeout(r, 300)); // let the Redis subscriber attach
});
beforeEach(wipeBatches);
afterAll(async () => {
  open.forEach((s) => s.close());
  forwarder.disconnect();
  server.close();
  await wipeBatches();
  await prisma.user.deleteMany({ where: { email: "outsider2@test.local" } });
  redis.disconnect();
  await prisma.$disconnect();
});

describe("Everyone sees changes as they happen", () => {
  it("rejects sockets without a valid token", async () => {
    await expect(client()).rejects.toThrow(/unauthorized/);
    await expect(client("garbage")).rejects.toThrow(/unauthorized/);
  });

  it("pushes batch updates to the right people only, with no personal data", async () => {
    const north = await prisma.district.findUniqueOrThrow({ where: { code: "DIST-02" } });
    const outsider = await prisma.user.upsert({
      where: { email: "outsider2@test.local" },
      update: {},
      create: { name: "Outsider", email: "outsider2@test.local", passwordHash: "x", role: "DISTRICT_OFFICER", districtId: north.id },
    });

    const anika = await client(await tokenFor("anika"));
    const dev = await client(await tokenFor("dev"));
    const farah = await client(await tokenFor("farah"));
    const other = await client(tokenForUser({ id: outsider.id, email: outsider.email, role: outsider.role, districtId: north.id, name: "x" }));
    const [a, d, f, o] = [anika, dev, farah, other].map((s) => collect(s, "batch.updated"));

    const id = await submittedBatch(3); // centre submit -> event
    await review("dev", id, "district", "APPROVED"); // officer decision -> event
    await settle();

    for (const got of [a, d, f]) {
      expect(got.length).toBeGreaterThanOrEqual(2);
      expect(got.every((e) => e.batchId === id)).toBe(true);
      expect(got.some((e) => e.status === "DISTRICT_PENDING")).toBe(true);
    }
    expect(o).toHaveLength(0); // other district hears nothing
    expect(JSON.stringify(a)).not.toMatch(/phone|nationalId|fullName/);
  });

  it("a client cannot subscribe itself to someone else's room", async () => {
    const anika = await client(await tokenFor("anika"));
    anika.emit("join", "role:STATE_OFFICE"); // the old client-driven join must be gone
    await settle();
    const inStateRoom = await getIO()!.in("role:STATE_OFFICE").fetchSockets();
    expect(inStateRoom.some((s) => s.data.user.email.startsWith("anika"))).toBe(false);
  });
});
