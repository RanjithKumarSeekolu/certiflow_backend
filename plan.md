# CertiFlow Backend: Phase Plan to Finish

Hard deadline: **2:30 pm.** Judged on correctness, tests that prove the moments, honest limits. Depth over breadth.
Supersedes `plan-build.md` (the earlier draft). TypeScript setup is done (`plan-ts-setup.md`).

## Audit: what is real vs. what is not (checked in code, 8/8 tests pass)

| Area | State |
|---|---|
| Auth, roles, JWT, demo-login | Exists. |
| Batch create, upload, submit, resubmit | Exists. Upload and review run in `prisma.$transaction`. |
| District, quality, state review | Exists, with optimistic `version` check and a unique approval per officer per cycle. |
| Audit log on decisions | Exists in the review paths. |
| Certificates: issue, revoke, verify | Exist, but **issuance is a manual synchronous endpoint** (`POST /certificates/batch/:id/issue`). State approval does **not** trigger it. It loops candidates in one request. |
| PDF generation | Worker file exists, called inline, not from a queue. |
| WhatsApp stand-in | Provider exists (failure and timeout simulation). **No worker consumes it** (`whatsapp.worker.ts` is empty). |
| Event queue | **Not implemented.** `amqplib` is installed, but `queues/*.ts` are empty and nothing publishes or consumes. |
| SLA escalation | `SlaMonitorWorker` exists but only runs when an endpoint is called. **No schedule.** |
| Realtime | `socket.ts` exists, but **no service emits events.** |
| Public verify | Route exists. **No rate limit.** |
| Certificate files | **Served publicly** via `express.static("/certificates")`. Violates "stranger can't get a certificate". |
| Migrations | **None.** Compose has no broker and no worker service. |
| **Tests** | 8 pass, but they mostly **re-implement logic inside the test** (e.g. Moment 2 builds its own vote array). They do not call the real services or DB, so they don't prove the moments. |

Biggest gaps, in order: queue pipeline, real tests, public file access, scheduling and realtime wiring, containers and migrations.

## Decisions (put in README requirements note)

- District needs **2 distinct approvals** per review cycle; quality step for batches **>= 50**; then state.
- Send-back **voids all earlier approvals** (`reviewCycle++`), kept in audit history.
- SLA breach **escalates once** to the state office.
- Cancel (revoke) is **state office only**, with a reason; verification reflects it immediately.
- Candidates get a **signed, expiring download link**; verify returns **masked, minimal** data.
- Broker: **RabbitMQ** (dependency already present). If time runs short: DB-polling workers using `FOR UPDATE SKIP LOCKED`, documented in README.

## Phases (each ends with something runnable and a real test)

### Phase 0: Green baseline and containers (~30 min)
- `prisma migrate dev --name init`; commit `prisma/migrations`; container start runs `prisma migrate deploy`, then seed.
- Compose: add `rabbitmq` (with healthcheck), a `worker` service (same image, different command), keep postgres and redis. Move the `JWT_SECRET` and DB passwords to `.env`.
- Add `worker` entry script (`src/worker.ts`) and npm scripts `start:worker`, `dev:worker`.
- Done when: `docker compose up --build` starts everything, `/health` is ok, demo users exist.

### Phase 1: Test harness that hits the real code (~30 min)
- Test DB: second Postgres database or schema, `prisma migrate deploy` in vitest `globalSetup`, truncate between tests.
- Use `supertest` against `app` with real JWTs from seed users.
- Replace the simulation tests one by one as phases land. Keep the unit tests (`CandidateRowSchema`, hash) as they are.
- Done when: one supertest login test passes against the test DB.

### Phase 2: Upload and approval flow, proven (~40 min)
- Moment 1 test: upload an xlsx with 3 bad rows. Expect 3 row-level errors and **0 candidates saved**.
- Moment 2 test: two officers approve in parallel (`Promise.all`). Expect exactly one status advance and no 500.
- Fix handling: catch the Prisma unique and version-conflict errors and return **409**.
- Moment 6 test: send back, resubmit, old approvals don't count, fresh consensus needed.
- Security tests: wrong role 403, wrong district 403, wrong step 409, identity from the token only.
- Done when: those tests pass against real endpoints.

### Phase 3: Event pipeline: approval to certificate to WhatsApp (~90 min, the core)
- `queues/queue-names.ts`, `queues/publish-job.ts`: exchange, queues, retry queue with TTL, dead-letter queue.
- On state approval (same transaction): create `Certificate` rows (cert number from a **DB sequence**, `candidateId` unique) and `DeliveryJob` rows. After commit, publish one `certificate.issued` event per certificate. A sweeper re-publishes `PENDING` jobs that never got published (outbox safety net).
- `pdf` consumer: generate the PDF, store the path, publish `certificate.pdf_ready`. Idempotent: skip if the file exists.
- `whatsapp` consumer: send via stand-in provider, update the `DeliveryJob`, retry with backoff up to `maxAttempts`, then dead-letter. Idempotency key prevents double sends. Ack only after the DB write.
- Remove the manual `issue` endpoint from the happy path (keep it as an admin "re-trigger" that is safe to call twice).
- Moment 3 test: 60 candidates, 35% provider failure, restart the consumer midway. Expect exactly 60 certificates, 60 delivered, 0 duplicates.
- Done when: approving a batch makes certificates and messages appear with no manual call.

### Phase 4: Verify, cancel, and file access (~40 min)
- Remove `express.static("/certificates")`. Add `GET /api/certificates/:id/download?token=...`: token is an HMAC or JWT with expiry, tied to the certificate id. The WhatsApp message carries this link.
- Public verify: rate limit via Redis (fall back to memory), minimal masked response, same shape for unknown ids (no probing hints).
- Revoke: set REVOKED, audit entry, realtime event. No cache, or invalidate on revoke.
- Moment 4 test: revoke, then verify immediately returns revoked. Download with a bad or expired token returns 403.
- Done when: stranger tests pass.

### Phase 5: SLA escalation and realtime (~40 min)
- Schedule: worker runs the SLA scan on an interval. Add an `escalatedAt` column so each breach fires **once** (needs a migration). Writes an audit entry and emits an event.
- Wire `emit` from the services (batch status changes, issuance, delivery, revoke). Authenticate the socket on handshake. Rooms per user and per role.
- Redis adapter for Socket.IO if Redis is available.
- Moment 5 test: backdate a deadline, run the scan twice, expect one escalation and one audit row.
- Done when: a status change shows up in a connected socket client.

### Phase 6: Observability and hardening (~30 min)
- Request id middleware. Carry it into events and worker logs. Structured log lines (JSON).
- Audit completeness: every transition and every revoke has actor and time.
- Input validation on every route (zod), CORS allowlist, `helmet`, request size limits.
- Basic `/health` readiness check (DB, Redis, RabbitMQ).
- Done when: you can follow one batch from upload to delivery in the logs by one id.

### Phase 7: Docs and submission (**start 60 min before 2:30 pm, no skipping**)
- README: requirements note on top, architecture, decisions and why, AI usage log, known limits.
- SETUP.md: fresh clone to running to seeded to tests passing. Verify it on a clean checkout.
- DEPLOYMENT.md: diagram, hosting and why, scaling for 30k PDFs and messages per hour, failure handling (worker crash, Redis restart, WhatsApp outage, slow DB), file storage and access, monitoring, monthly cost.
- Demo video (<= 2 min): bad upload, two-officer approval, certificates delivered, cancel, verify fails.

## Never-happen checklist (each needs a test)

- [ ] Wrong role, step or district gets blocked; no acting as someone else.
- [ ] No duplicate certificate per candidate; no duplicate certificate number.
- [ ] Cancelled certificate never verifies as genuine.
- [ ] No unauthenticated access to certificate files or personal details.
- [ ] Every decision has an audit row with actor and time.

## Cut lines (cut from the bottom)

1. **Keep:** Phases 0 to 4, Phase 7.
2. **Cut next:** Socket.IO Redis adapter, then Phase 6 extras, then the verify rate limit (document it).
3. **Never cut:** transactional upload, concurrency safety, idempotent delivery, audit log, DEPLOYMENT.md.
4. State in the README exactly what was cut.

## Known risks to watch

- `Batch.update({ where: { id, version } })` throws on a version mismatch; make sure it maps to 409, not 500.
- Certificate number generation must come from the DB (sequence), not random in code, to avoid collisions at scale.
- `.env.example` points at Supabase; the compose setup must work offline with the local Postgres.
