import { execSync } from "child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:test@localhost:55432/certiflow_test?schema=public";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error("Refusing to run tests against a non-local database");
  }
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  execSync("npx prisma migrate deploy", { env, stdio: "inherit" });
  execSync("npx tsx prisma/seed.ts", { env, stdio: "ignore" });
}
