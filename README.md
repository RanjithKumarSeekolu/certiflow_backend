# CertiFlow: Skilling Certificate Issuance Platform

> **Build the system that decides who gets certified, issues the certificate, and lets anyone check that a certificate is genuine.**

---

## 1. Requirements Note & Problem Understanding

The Pragati Skills Mission certifies ~8,000 vocational students monthly across 300+ private training centres. Previously, batches were submitted via spreadsheets, approved informally over messaging, and certificates typed manually into Word documents. This resulted in multi-week delays, untraceable approvals, and circulating fraudulent certificates.

### Core System Requirements
1. **Multi-Role Governance**:
   * **Training Centres (Anika)**: Create batches, bulk-ingest candidate spreadsheets, submit for multi-stage approval, and handle revisions if sent back.
   * **District Officers (Dev, Meera, Kabir)**: Review batches for centres within their assigned district. **Requires $\ge 2$ distinct officer approvals to advance**.
   * **Quality Team (Neha)**: Extra scrutiny on large batches ($> 50$ candidates) prior to state review.
   * **State Office (Farah)**: Final authority, oversees stalled batches via automated SLA monitoring, and holds immediate revocation power for fraudulent certificates.
   * **Candidates**: Receive verified certificates on WhatsApp with secure download links.
   * **Employers & Public**: Instant verification without login, protected by candidate identity privacy masking.

---

## 2. Key Technical Decisions & Architectural Rationale

### A. Atomic Spreadsheet Ingestion (Moment 1)
* **Decision**: All-or-nothing transactional validation using `xlsx` and `zod`.
* **Rationale**: If row 59 out of 60 contains an invalid phone number or duplicate national ID, the entire batch upload is rejected with exact row/field error reports. No partial or corrupt candidate data ever enters the database.

### B. Concurrency-Safe District Consensus (Moment 2)
* **Decision**: Database-level optimistic locking with row versioning and composite unique constraints (`[batchId, officerId, reviewCycle]`).
* **Rationale**: Prevents race conditions when two district officers click "Approve" at the same instant. The batch transitions to the next stage (`QUALITY_PENDING` or `STATE_PENDING`) exactly once, never twice.

### C. Event-driven issuance and delivery (Moment 3)
* **Decision**: RabbitMQ pipeline `batch.issue -> certificate.render -> certificate.deliver`, consumed by a separate **worker** process. State approval only records the decision and enqueues `batch.issue`; the request never waits for PDFs or WhatsApp.
* **Reliability**: handlers are idempotent (`Certificate.candidateId` unique, `DeliveryJob.idempotencyKey` unique, job claimed atomically before sending). A message is acked only after its DB write, so a crashed worker's messages are redelivered. Failures retry via a delay queue (5 s, up to 5 attempts), then go to a dead-letter queue and the job is marked `FAILED`; `POST /api/certificates/batch/:id/issue` re-drives them. A worker **sweeper** re-publishes lost work (e.g. broker down at approval time). Workers reconnect by themselves if RabbitMQ restarts.
* **Rationale**: WhatsApp is unreliable (stand-in fails, and also "times out after delivering", the case that causes duplicate sends). The idempotency key makes a retry a no-op at the provider, so each candidate gets exactly one message. Scale by adding workers (`docker compose up --scale worker=3`).
* **Honest limit**: this assumes the WhatsApp provider honours an idempotency key (the stand-in does). A provider without one is at-least-once: a crash between "sent" and "marked sent" could resend.

### D. Public Verification & Instant Revocation (Moment 4)
* **Decision**: Verification is answered from PostgreSQL on every request (indexed lookup, `Cache-Control: no-store`). Redis only holds a shared per-IP rate limit (60/min) that fails open if Redis is down.
* **Rationale**: Thousands of lookups a day is small for an indexed row, and not caching removes any way for a stale cache or CDN to show a cancelled certificate as valid. Responses are minimal and masked (`R***l K***r`): no phone, national ID, score, hash or file link.
* **Certificate files**: PDFs are not served statically. Candidates get a signed, expiring link (`/api/certificates/:id/download?token=...`); cancelled certificates return 410.

### E. Proactive SLA Breach Detection (Moment 5)
* **Decision**: Each approval step has its own deadline (`SLA_HOURS`, default 48). The worker scans every minute and escalates a breached step **once** (`escalatedAt` is claimed atomically, so concurrent workers can't double-escalate): an audit entry plus a realtime event to the state office. The clock and escalation re-arm when the batch moves to the next step or is resubmitted.
* **Visibility**: `GET /api/batches/stuck` (state office) is read-only and lists everything currently overdue.

### F. Deliberate Send-Back & Resubmission Lifecycle (Moment 6)
* **Decision**: Documented cycle increments (`reviewCycle = reviewCycle + 1`) that reset active approvals while retaining historical audit records.
* **Rationale**: If an officer sends a batch back with revision feedback, fixing candidate data fundamentally alters the batch. Prior district approvals are archived under cycle 1, and the batch requires fresh multi-officer consensus under cycle 2.

---

## 3. Tech Stack

* **Runtime**: Node.js (v20+), Express, TypeScript
* **Database & ORM**: PostgreSQL (Supabase), Prisma ORM v6
* **Redis**: verify rate limiting and realtime fan-out (`ioredis`)
* **Certificate Engine**: `pdfkit` (tamper-evident SHA-256 fingerprinting)
* **Messaging**: Stand-in flaky WhatsApp provider with simulated failure and retry logic
* **Event queue**: RabbitMQ (`amqplib`), separate worker process
* **Realtime**: Socket.IO (JWT-authenticated), events fanned out through Redis pub/sub
* **Testing**: Vitest, Supertest

---

## 4. Verification: The 6 Mandatory Moments

`npm test` runs integration tests through the real Express app against a real PostgreSQL and Redis (throwaway Docker containers, see SETUP.md). They cover:

* **Moment 1**: bad rows reported with row numbers, nothing saved
* **Moment 2**: concurrent officer approvals never advance twice; one vote per officer; two distinct officers needed
* **Moment 3**: 60 candidates through district, quality and state (no manual issue call), 35% provider failure plus timeouts-after-delivery, a worker restart midway: 60 certificates, 60 delivered, every message sent exactly once. Also: lost-message recovery, dead-letter then re-drive, unapproved batches refused
* **Moment 4**: revoke then verify is immediately "revoked"; only state office can revoke; signed download links only
* **Moment 5**: overdue batch flagged, one escalation even if scanned repeatedly or concurrently; each step has its own clock
* **Moment 6**: send back and resubmit: earlier approvals don't count, history kept
* **Realtime**: unauthenticated sockets refused, events reach the right rooms only, no PII in payloads, clients cannot join rooms themselves
* **Visibility**: officers' "waiting for me" inbox; no password hashes or candidate rows in list responses
* **Security**: wrong role/step/district blocked, forged tokens rejected, demo login off unless `DEMO_MODE=true`, verify rate-limited

---

---

## 5. Quick Links

* [SETUP.md](SETUP.md): Fresh clone setup guide
* [DEPLOYMENT.md](DEPLOYMENT.md): Production scaling plan for 100k users & 30k peak PDFs

---

## 6. API at a glance

Interactive docs (Swagger UI) at **`/api/docs`** once the API is running (e.g. http://localhost:8081/api/docs); raw OpenAPI JSON at `/api/docs.json` (import into Postman). Source: `src/docs/openapi.ts`; a test checks it against the app's auth rules.

| Who | Endpoints |
|---|---|
| Anyone | `GET /api/verify/:certificateNumber`, `GET /api/certificates/:id/download?token=` (signed link), `GET /health` |
| Auth | `POST /api/auth/login`, `POST /api/auth/demo-login` (demo only), `GET /api/auth/me` |
| Centre | `POST /api/batches`, `POST /api/batches/:id/upload` (xlsx/csv), `POST .../submit`, `POST .../resubmit` |
| Officers | `GET /api/batches?inbox=true` (waiting for me), `GET /api/batches/:id` (candidates, approvals, audit trail), `POST .../district-review`, `.../quality-review`, `.../state-review` |
| State office | `GET /api/batches/stuck`, `POST /api/certificates/:id/revoke`, `POST /api/certificates/batch/:id/issue` (re-drive) |
| Realtime | Socket.IO, `auth: { token }`; events `batch.updated`, `certificates.issued`, `certificate.delivered`, `certificate.delivery_failed`, `certificate.revoked`, `batch.sla_breached` |

Candidates, centres, approvals and audit entries are not separate resources: candidates arrive with the upload, centres are seeded, and approvals and the audit trail come back on the batch detail. Candidates do not log in; they get their certificate by WhatsApp. "Notifications" are the WhatsApp message to candidates and the realtime events to staff; there is no stored in-app notification feed.

---

## 7. Known Limitations (honest status)

* **WhatsApp is a stand-in**, and it dedupes on the idempotency key in memory. A real provider needs its own deduplication (see decision C).
* **PDFs live on a shared volume** (`uploads/`), not object storage. `DEPLOYMENT.md` describes S3 for production.
* **Centres are seeded**, with no admin screen. Candidate fixes after a send-back mean re-uploading the sheet.
* **Same national ID can be certified in two different batches** (unique per batch only).
* **Several workers each run the sweeper and SLA scan.** That is safe (idempotent) but wasteful; a leader lock would fix it.
* **No request ids or structured logging yet**; tracing is by batch id through the audit log and events.
* **No stored notification feed**, no email, no admin audit-search endpoint (the audit trail is on the batch detail).
* **Rotate any database password that was ever committed** in an earlier `.env.example`.
