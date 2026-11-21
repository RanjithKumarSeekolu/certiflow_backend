/**
 * OpenAPI 3 description of the CertiFlow API. Served as Swagger UI at /api/docs and as JSON at
 * /api/docs.json (importable into Postman/Insomnia). Hand-written: keep it in step with the routers.
 */
const err = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const idParam = (name: string, description: string) => ({
  name, in: "path", required: true, description, schema: { type: "string", format: "uuid" },
});
const secured = [{ bearerAuth: [] }];
const r401 = { $ref: "#/components/responses/Unauthorized" };
const r403 = { $ref: "#/components/responses/Forbidden" };
const r404 = { $ref: "#/components/responses/NotFound" };
const r409 = { $ref: "#/components/responses/Conflict" };

const reviewOp = (summary: string, description: string, tag: string) => ({
  tags: [tag],
  summary,
  description,
  security: secured,
  parameters: [idParam("id", "Batch id")],
  requestBody: { required: true, content: json(ref("ReviewRequest")) },
  responses: {
    "200": { description: "Decision recorded; the updated batch", content: json(ref("Batch")) },
    "400": err("Validation failed, or the batch is not at this step (wrong step), or the officer already voted this cycle"),
    "401": r401, "403": r403,
    "409": err("Another decision was recorded at the same moment. Nothing was lost or double-applied: refresh and retry."),
  },
});

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "CertiFlow API",
    version: "1.0.0",
    description: [
      "Skilling certificate issuance platform for the Pragati Skills Mission.",
      "",
      "**Flow:** centre uploads a batch → district officers (2 distinct approvals) → quality team if the batch has more than 50 candidates → state office → certificates are issued, rendered and sent on WhatsApp by background workers → anyone can verify a certificate.",
      "",
      "**Authentication:** call `POST /api/auth/demo-login` (demo mode) or `/api/auth/login`, then click **Authorize** and paste the token. Personas: `anika` (centre), `dev`, `meera`, `kabir` (district officers), `neha` (quality), `farah` (state office).",
      "",
      "**Realtime:** Socket.IO on the same host. Connect with `auth: { token }`. Events: `batch.updated`, `certificates.issued`, `certificate.delivered`, `certificate.delivery_failed`, `certificate.revoked`, `batch.sla_breached`. Payload: `{ type, batchId, status, at }` (no personal data).",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  tags: [
    { name: "System" }, { name: "Auth" }, { name: "Centre" }, { name: "Officers" },
    { name: "State office" }, { name: "Public" },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    responses: {
      Unauthorized: err("Missing, invalid or expired token"),
      Forbidden: err("Your role, district or centre does not allow this action"),
      NotFound: err("Not found"),
      Conflict: err("Conflict with the current state (e.g. already revoked)"),
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      Role: { type: "string", enum: ["CENTRE", "DISTRICT_OFFICER", "QUALITY_TEAM", "STATE_OFFICE"] },
      BatchStatus: {
        type: "string",
        enum: ["DRAFT", "SUBMITTED", "DISTRICT_PENDING", "QUALITY_PENDING", "STATE_PENDING", "APPROVED", "REJECTED", "SENT_BACK"],
      },
      Decision: { type: "string", enum: ["APPROVED", "REJECTED", "SENT_BACK"] },
      LoginRequest: {
        type: "object", required: ["email", "password"],
        properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 6 } },
      },
      DemoLoginRequest: {
        type: "object", required: ["persona"],
        properties: { persona: { type: "string", enum: ["anika", "dev", "meera", "kabir", "neha", "farah"] } },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" }, name: { type: "string" }, email: { type: "string" },
          role: ref("Role"), districtId: { type: "string", nullable: true },
        },
      },
      AuthResponse: { type: "object", properties: { token: { type: "string" }, user: ref("User") } },
      CreateBatchRequest: {
        type: "object", required: ["courseName"], properties: { courseName: { type: "string", minLength: 2, example: "Welding Level 2" } },
      },
      Approval: {
        type: "object",
        properties: {
          officerId: { type: "string" }, role: ref("Role"), decision: ref("Decision"),
          reviewCycle: { type: "integer", description: "Starts at 1; increases each time the batch is sent back and resubmitted. Only approvals in the current cycle count." },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Batch: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" }, batchNumber: { type: "string", example: "BATCH-2026-A1B2C3" },
          courseName: { type: "string" }, status: ref("BatchStatus"), totalCandidates: { type: "integer" },
          reviewCycle: { type: "integer" }, version: { type: "integer", description: "Optimistic-lock counter" },
          slaDeadline: { type: "string", format: "date-time", nullable: true, description: "Deadline for the CURRENT approval step" },
          escalatedAt: { type: "string", format: "date-time", nullable: true },
          submittedAt: { type: "string", format: "date-time", nullable: true },
          approvedAt: { type: "string", format: "date-time", nullable: true },
          approvals: { type: "array", items: ref("Approval") },
        },
      },
      BatchDetail: {
        allOf: [ref("Batch"), {
          type: "object",
          description: "Includes candidates, approvals (with officer name), certificates and the full audit trail",
          properties: {
            candidates: { type: "array", items: { type: "object" } },
            certificates: { type: "array", items: ref("Certificate") },
            auditLogs: {
              type: "array",
              items: { type: "object", properties: { action: { type: "string" }, actorId: { type: "string", nullable: true }, actorRole: { type: "string", nullable: true }, timestamp: { type: "string", format: "date-time" }, details: { type: "object" } } },
            },
          },
        }],
      },
      UploadSuccess: {
        type: "object",
        properties: { success: { type: "boolean", example: true }, totalRows: { type: "integer" }, candidateCount: { type: "integer" }, errors: { type: "array", items: {} } },
      },
      UploadFailure: {
        type: "object",
        description: "Every bad row is reported and NOTHING is saved.",
        properties: {
          success: { type: "boolean", example: false }, totalRows: { type: "integer" }, errorCount: { type: "integer" },
          errors: {
            type: "array",
            items: { type: "object", properties: { row: { type: "integer", description: "Spreadsheet row (header is row 1)" }, field: { type: "string" }, message: { type: "string" } } },
          },
        },
      },
      ReviewRequest: {
        type: "object", required: ["decision"],
        properties: { decision: ref("Decision"), comments: { type: "string", description: "Reason; expected for REJECTED and SENT_BACK" } },
      },
      SlaBreach: {
        type: "object",
        properties: {
          batchId: { type: "string" }, batchNumber: { type: "string" }, centreName: { type: "string" }, status: ref("BatchStatus"),
          slaDeadline: { type: "string", format: "date-time" }, overdueMinutes: { type: "integer" },
          escalatedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Certificate: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" }, certificateNumber: { type: "string", example: "CERT-2026-8EFC05CAC356B057" },
          candidateId: { type: "string" },
          status: { type: "string", enum: ["VALID", "REVOKED"] }, issuedAt: { type: "string", format: "date-time" },
          deliveryJobs: {
            type: "array", description: "WhatsApp delivery state (PENDING, PROCESSING, COMPLETED, FAILED)",
            items: { type: "object", properties: { status: { type: "string" }, attempts: { type: "integer" }, lastError: { type: "string", nullable: true }, deliveredAt: { type: "string", format: "date-time", nullable: true } } },
          },
          revokedAt: { type: "string", format: "date-time", nullable: true }, revocationReason: { type: "string", nullable: true },
        },
      },
      Queued: { type: "object", properties: { batchId: { type: "string" }, status: { type: "string", example: "queued" } } },
      RevokeRequest: { type: "object", required: ["reason"], properties: { reason: { type: "string", example: "Forged marksheet detected" } } },
      VerificationResult: {
        type: "object",
        description: "Masked and minimal on purpose: no phone, national ID, score, hash or file link.",
        properties: {
          valid: { type: "boolean" }, status: { type: "string", enum: ["VALID", "REVOKED", "NOT_FOUND"] },
          certificateNumber: { type: "string" }, candidateName: { type: "string", example: "R***l K***r" },
          courseName: { type: "string" }, grade: { type: "string" }, issuedAt: { type: "string", format: "date-time" },
          revokedAt: { type: "string", format: "date-time", nullable: true }, revocationReason: { type: "string", nullable: true },
        },
      },
    },
  },
  paths: {
    "/": { get: { tags: ["System"], summary: "Service info", responses: { "200": { description: "Service is up" } } } },
    "/health": { get: { tags: ["System"], summary: "Health check", responses: { "200": { description: "OK", content: json({ type: "object", properties: { status: { type: "string", example: "ok" } } }) } } } },

    "/api/auth/login": {
      post: {
        tags: ["Auth"], summary: "Log in with email and password",
        requestBody: { required: true, content: json(ref("LoginRequest")) },
        responses: { "200": { description: "Token and user", content: json(ref("AuthResponse")) }, "400": err("Validation failed"), "401": err("Invalid credentials") },
      },
    },
    "/api/auth/demo-login": {
      post: {
        tags: ["Auth"], summary: "Switch to a demo persona (no password)",
        description: "Only available when `DEMO_MODE=true`; otherwise 404. Must be off in production.",
        requestBody: { required: true, content: json(ref("DemoLoginRequest")) },
        responses: { "200": { description: "Token and user", content: json(ref("AuthResponse")) }, "400": err("Unknown persona"), "404": err("Demo mode is disabled") },
      },
    },
    "/api/auth/me": {
      get: { tags: ["Auth"], summary: "Who am I", security: secured, responses: { "200": { description: "Current user", content: json({ type: "object", properties: { user: ref("User") } }) }, "401": r401 } },
    },

    "/api/batches": {
      get: {
        tags: ["Centre", "Officers"], summary: "List batches I can see (lean: no candidates)",
        description: "Centres see their own; district officers their district; quality and state see all. With `inbox=true` only batches waiting for **my** action: centre → SENT_BACK, district → DISTRICT_PENDING and not yet voted this cycle, quality → QUALITY_PENDING, state → STATE_PENDING.",
        security: secured,
        parameters: [
          { name: "inbox", in: "query", schema: { type: "boolean" }, description: "Only batches waiting for my action" },
          { name: "status", in: "query", schema: ref("BatchStatus") },
        ],
        responses: { "200": { description: "Batches, newest first (max 200)", content: json({ type: "array", items: ref("Batch") }) }, "400": err("Unknown status"), "401": r401 },
      },
      post: {
        tags: ["Centre"], summary: "Create a draft batch", security: secured,
        requestBody: { required: true, content: json(ref("CreateBatchRequest")) },
        responses: { "201": { description: "Draft batch", content: json(ref("Batch")) }, "400": err("Validation failed or user has no training centre"), "401": r401, "403": r403 },
      },
    },
    "/api/batches/stuck": {
      get: {
        tags: ["State office"], summary: "Batches currently past their SLA (read-only)",
        description: "Escalation itself is done by the scheduled worker, once per step.",
        security: secured, responses: { "200": { description: "Overdue batches", content: json({ type: "array", items: ref("SlaBreach") }) }, "401": r401, "403": r403 },
      },
    },
    "/api/batches/{id}": {
      get: {
        tags: ["Centre", "Officers"], summary: "Batch detail with candidates, approvals, certificates and audit trail",
        security: secured, parameters: [idParam("id", "Batch id")],
        responses: { "200": { description: "Batch detail", content: json(ref("BatchDetail")) }, "401": r401, "403": r403, "404": r404 },
      },
    },
    "/api/batches/{id}/upload": {
      post: {
        tags: ["Centre"], summary: "Upload candidates from a spreadsheet (all or nothing)",
        description: "Allowed while the batch is DRAFT or SENT_BACK; replaces earlier candidates. Columns: `fullName`, `phone` (10–13 digits), `nationalId`, `score` (0–100), optional `grade`. If any row is bad, every error is returned and nothing is saved.",
        security: secured, parameters: [idParam("id", "Batch id")],
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary", description: ".xlsx, .xls or .csv, max 10 MB" } } } } },
        },
        responses: {
          "200": { description: "All rows saved", content: json(ref("UploadSuccess")) },
          "400": err("No file, wrong batch state, or unreadable spreadsheet"),
          "401": r401, "403": r403,
          "422": { description: "Validation failed; nothing was saved", content: json(ref("UploadFailure")) },
        },
      },
    },
    "/api/batches/{id}/submit": {
      post: {
        tags: ["Centre"], summary: "Send a draft batch for approval", description: "Moves DRAFT → DISTRICT_PENDING and starts the SLA clock.",
        security: secured, parameters: [idParam("id", "Batch id")],
        responses: { "200": { description: "Updated batch", content: json(ref("Batch")) }, "400": err("Not a draft, or no candidates"), "401": r401, "403": r403 },
      },
    },
    "/api/batches/{id}/resubmit": {
      post: {
        tags: ["Centre"], summary: "Resubmit a sent-back batch",
        description: "SENT_BACK → DISTRICT_PENDING with `reviewCycle + 1`. **All earlier approvals stop counting** (they stay in the history): two fresh district approvals are required.",
        security: secured, parameters: [idParam("id", "Batch id")],
        responses: { "200": { description: "Updated batch", content: json(ref("Batch")) }, "400": err("Batch is not SENT_BACK"), "401": r401, "403": r403 },
      },
    },
    "/api/batches/{id}/district-review": {
      post: reviewOp(
        "District officer decision",
        "Only officers of the batch's own district. **Two distinct approvals** in the current cycle advance the batch (to QUALITY_PENDING if it has more than 50 candidates, else STATE_PENDING). One reject or send-back ends the round. An officer can vote once per cycle.",
        "Officers"
      ),
    },
    "/api/batches/{id}/quality-review": {
      post: reviewOp("Quality team decision (batches over 50 candidates)", "Only at QUALITY_PENDING. Approve → STATE_PENDING.", "Officers"),
    },
    "/api/batches/{id}/state-review": {
      post: reviewOp(
        "State office final decision",
        "Only at STATE_PENDING. **Approve → APPROVED**, which automatically queues certificate issuance; the response does not wait for PDFs or WhatsApp.",
        "State office"
      ),
    },

    "/api/certificates/batch/{batchId}/issue": {
      post: {
        tags: ["State office"], summary: "Re-drive issuance for an APPROVED batch",
        description: "Normally unnecessary: approval already queues issuance. Use it to re-open deliveries that exhausted their retries (FAILED). Safe to call repeatedly.",
        security: secured, parameters: [idParam("batchId", "Batch id")],
        responses: { "202": { description: "Queued", content: json(ref("Queued")) }, "401": r401, "403": r403, "404": r404, "409": err("Batch is not APPROVED") },
      },
    },
    "/api/certificates/{id}/download-link": {
      post: {
        tags: ["State office", "Centre"], summary: "Get a fresh signed download link for a certificate",
        description: "State office, or the centre that owns the batch. The link is relative and valid for one hour; open it to download the PDF.",
        security: secured, parameters: [idParam("id", "Certificate id")],
        responses: {
          "200": { description: "Signed link", content: json({ type: "object", properties: { url: { type: "string" }, expiresInSeconds: { type: "integer" } } }) },
          "401": r401, "403": r403, "404": r404,
        },
      },
    },
    "/api/certificates/{id}/revoke": {
      post: {
        tags: ["State office"], summary: "Cancel a certificate",
        description: "Takes effect immediately for verification and downloads. Audited.",
        security: secured, parameters: [idParam("id", "Certificate id")],
        requestBody: { required: true, content: json(ref("RevokeRequest")) },
        responses: { "200": { description: "Revoked certificate", content: json(ref("Certificate")) }, "400": err("Reason is required"), "401": r401, "403": r403, "404": r404, "409": r409 },
      },
    },
    "/api/certificates/{id}/download": {
      get: {
        tags: ["Public"], summary: "Download a certificate PDF (signed link)",
        description: "The link sent to the candidate on WhatsApp. The signed, expiring `token` is the only credential.",
        parameters: [idParam("id", "Certificate id"), { name: "token", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } },
          "403": err("Missing, invalid or expired token"), "404": r404, "410": err("Certificate was cancelled"),
        },
      },
    },
    "/api/verify/{identifier}": {
      get: {
        tags: ["Public"], summary: "Check whether a certificate is genuine (no login)",
        description: "Answered from the database on every request, so a cancelled certificate is never reported valid. Rate limited to 60 requests per minute per client.",
        parameters: [{ name: "identifier", in: "path", required: true, schema: { type: "string" }, description: "Certificate number (e.g. CERT-2026-…)" }],
        responses: {
          "200": { description: "Found (check `valid`)", content: json(ref("VerificationResult")) },
          "404": { description: "No such certificate", content: json(ref("VerificationResult")) },
          "429": err("Too many requests"),
        },
      },
    },
  },
};
