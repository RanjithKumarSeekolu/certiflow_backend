import express from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { openapi } from "./docs/openapi";
import { corsOrigins } from "./config/env";
import authRouter from "./modules/auth/auth.router";
import batchRouter from "./modules/batches/batch.router";
import certificateRouter from "./modules/certificates/certificate.router";
import verificationRouter from "./modules/verification/verification.router";

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: corsOrigins() }));
app.use(express.json());

// Certificate PDFs are NOT served statically: see GET /api/certificates/:id/download (signed link).

// Healthcheck
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "CertiFlow Backend API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// API docs: Swagger UI plus the raw spec (importable into Postman)
app.get("/api/docs.json", (_req, res) => res.json(openapi));
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "CertiFlow API" }));

// Mount module routers
app.use("/api/auth", authRouter);
app.use("/api/batches", batchRouter);
app.use("/api/certificates", certificateRouter);
app.use("/api/verify", verificationRouter);

export default app;
