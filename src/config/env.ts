// Read lazily so tests and dotenv can set env before first use; fail fast if missing.
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

// Demo persona login is an auth bypass by design; only on when explicitly enabled.
export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

// How long a batch may sit at one approval step before it is escalated.
export function slaDeadlineFromNow(): Date {
  const hours = Number(process.env.SLA_HOURS) || 48;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

// Browser origins allowed to call the API and open sockets (comma-separated).
export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://localhost:3000").split(",").map((o) => o.trim());
}
