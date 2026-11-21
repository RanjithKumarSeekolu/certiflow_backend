# CertiFlow Build Plan

Deadline: **2:30 pm, no extensions.** Judged on depth, correctness, tests, and honesty. A small part that truly works beats a large part that falls over.

## Where we are (audit of the scaffold)

- Exists: Prisma schema (with `reviewCycle`, `version`, `DeliveryJob.idempotencyKey`, `AuditLog`), seed, auth, batch/certificate services, PDF and SLA workers, WhatsApp provider stub, `tests/moments.test.ts`.
- **Empty files:** `queues/publish-job.ts`, `queues/queue-names.ts`, `workers/whatsapp.worker.ts`. The event pipeline is not wired.
- **Missing:** Prisma migrations, a broker and worker services in `docker-compose.yml`, README, SETUP, DEPLOYMENT, and a verified end-to-end run.
- First task: run `npm run typecheck` and `npm test`, and write down what is red.

## Requirements decisions (copy into the top of README)

| Question the brief leaves open | Decision | Why |
|---|---|---|
| "More than one officer" at district | **2 distinct approvals** in the batch's district, in the current review cycle. A single reject or send-back ends the round. | Smallest rule that satisfies "more than one"; configurable constant. |
| "Large batch" | **≥ 50 candidates** adds a QUALITY step after district. Constant, documented. | The 60-candidate demo batch exercises it. |
| Flow | DRAFT → SUBMITTED → DISTRICT_PENDING → (QUALITY_PENDING if large) → STATE_PENDING → APPROVED. REJECTED is terminal. SENT_BACK returns to the centre. | |
| Send back, what happens to prior approvals (moment 6) | **All approvals are voided.** `reviewCycle++`, and old approvals stay in the audit trail but don't count. | The data changed, so earlier sign-offs were for different data. The audit trail is preserved. |
| "Stuck too long" | SLA of 48h per pending step, short in demo mode. On breach, **escalate once** to the state office with an audit entry and a realtime event. | Idempotent, so no repeat alerts. |
| Who can cancel | State office only, with a mandatory reason. Verification fails immediately. | |
| Candidate access | No login. WhatsApp message carries a **signed, expiring download link**. | A stranger can't guess it. |
| Public verification | Look up by `verificationHash` and return **minimal data** (masked name, course, issue date, status). Never phone or national ID. | Privacy rule. |
| Self-approval | A user can't act outside their role, district, or current step. | "Never happens" #1. |

## Architecture (keep it boring)

- **Postgres** is the source of truth. State changes are transactional.
- **RabbitMQ** carries events. `amqplib` is already a dependency. It gives retry queues and a DLQ without extra code. Add it to compose.
  - Fallback if behind schedule: workers poll `DeliveryJob` with `FOR UPDATE SKIP LOCKED`. Say so in the README if used.
- **Outbox pattern:** the approval transaction writes certificates and `DeliveryJob` rows. A publisher then emits events. The HTTP request never waits for the PDF or WhatsApp.
- **Workers** (separate container, scalable): `pdf` → `whatsapp` → `sla`. Each consumer is idempotent (`idempotencyKey` unique) and acks only after the DB write.
- **Redis:** rate limiting on the public verify endpoint, the Socket.IO adapter (multi-instance), and a short-TTL verify cache **invalidated on revoke**. If invalidation isn't done, skip the cache.
- **Socket.IO:** authenticate on handshake, join per-role and per-user rooms, and emit on state change.

## Order of work (vertical slices, prove each with a test before moving on)

**Phase 0: Green baseline (~20 min).** Typecheck and tests run. `docker compose up` brings up Postgres, Redis, RabbitMQ, the API and a worker. Create the initial migration (`prisma migrate dev`) and use `migrate deploy` in the container start. Seed the six demo users (Anika, Dev, Meera, Kabir, Neha, Farah).

**Phase 1: Upload (moment 1).** Parse xlsx/csv, validate **every** row with zod, and return all errors with row numbers. Insert in **one transaction**, all or nothing. Enforce a file size limit and a MIME check, and dedupe on `(batchId, nationalId)`.
- Test: a file with 3 bad rows returns 3 errors and 0 rows saved.

**Phase 2: Approval state machine (moments 2 and 6).** One `transition()` function holds every legal move and its role check. Concurrency: `UNIQUE(batchId, officerId, reviewCycle)`, plus a conditional update on `status` and `version` inside a transaction. The loser gets a 409, not a double advance. Add send-back with `reviewCycle++`, and centre fix-and-resubmit.
- Tests: two parallel approvals advance the batch once. Send-back voids approvals. A wrong role or wrong district gets 403.

**Phase 3: Issuance and delivery (moment 3).** On state APPROVED, create certificates in the same transaction. The number comes from a DB sequence and `candidateId` is unique. Publish the events. The PDF worker stores the file and the WhatsApp worker sends with retry, backoff and a DLQ. Make the stub fail and time out on a configurable rate.
- Test: 60 candidates, a 30% stub failure rate, and a worker killed mid-run all end with exactly 60 certificates and 60 delivered messages.

**Phase 4: Verify and cancel (moment 4).** `GET /verify/:hash` is public, rate-limited, and minimal. Cancel sets REVOKED, writes an audit entry, and invalidates the cache.
- Test: cancel, then verify immediately returns "revoked".

**Phase 5: SLA escalation (moment 5).** A periodic job finds steps past their deadline and not yet escalated, escalates once, and writes an audit entry and a realtime event.
- Test: advance the clock, run twice, and get one escalation.

**Phase 6: Realtime and access control polish.** Socket auth and rooms. Audit log on every decision (who, what, when). A `requestId` carried API → event → worker → logs for end-to-end tracing. `helmet`, CORS allowlist, and a real `JWT_SECRET` from env (the compose file currently hardcodes one).

**Phase 7: Docs and demo. Start by T-60 min before 2:30 pm. Do not skip.**
- README: requirements note at top, architecture, decisions with reasons, known limitations.
- SETUP.md: fresh clone → running → seeded → tests passing. Run it once on a clean checkout.
- DEPLOYMENT.md: diagram, hosting and why, scaling for 30k PDFs and messages per hour, failure handling (worker crash, Redis restart, WhatsApp outage, slow DB), file storage and access control, monitoring and alerts, monthly cost.
- Demo video, 2 minutes or less: bad upload → two-officer approval → certificates delivered → cancel → verify fails.

## Test matrix (this is the evidence)

| Requirement | Test |
|---|---|
| Moment 1: bad rows | Errors listed, nothing saved |
| Moment 2: concurrent approve | Advances once |
| Moment 3: 60 candidates, flaky WhatsApp | Exactly one certificate and one delivery each, after retries and a restart |
| Moment 4: cancel | Verify says revoked immediately |
| Moment 5: stuck batch | One escalation |
| Moment 6: send-back | Old approvals void, new cycle needs fresh approvals |
| Never: wrong step or impersonation | 403 for wrong role, district or step; the token user is used, never a body field |
| Never: duplicate certificate or number | DB constraints reject; replayed events don't duplicate |
| Never: cancelled shows genuine | Covered by moment 4, including the cache |
| Never: stranger gets data | Bad or expired signed link → 403; verify returns no PII |
| Never: untraceable decision | Every transition has an audit row with actor and time |

## Cut lines if time runs out (cut from the bottom)

1. Keep: Phases 0–4, the test matrix, README and SETUP.
2. Cut next: Redis verify cache (keep rate limiting), then the Socket.IO adapter, then the quality-team step polish.
3. Never cut: transactional upload, concurrency safety, idempotent delivery, audit log, DEPLOYMENT.md.
4. Say honestly in the README what was cut.

## AI usage log (judged, so keep it current)

For each AI-generated piece, record one line in the README: what it produced, what you changed, and how you checked it (test, manual run, code read). You must be able to explain every line you submit. Review diffs before committing, and make small commits with meaningful messages.

## Working habits (carried over from the old plan)

- One clear prompt per task with the relevant files and acceptance criteria.
- Ask for a short plan before multi-file changes.
- Run tests and review the diff before the next request.
- Use a smaller model for routine edits. Reserve the larger one for the state machine and concurrency work.
- If quota runs out, switch tools. Don't spend time on workarounds.
