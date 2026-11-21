# Plan: TypeScript + Express backend foundation

Goal: strict TypeScript, Node.js, Express, with working `dev`, `typecheck`, `build`, `start`, and a `/health` check.

## Current state (checked against this repo)

- Already installed: `typescript`, `tsx`, `@types/node`, `@types/express`, `@types/cors`, and `helmet`, `cors`, `express`.
- `tsconfig.json` already matches the target config (NodeNext, strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `rootDir: ./src`, tests excluded).
- Scripts `dev`, `build`, `start`, `typecheck` already exist in `package.json`.
- `src/app.ts` and `src/server.ts` already exist with real code. **Don't overwrite them** with the starter snippets.
- `package.json` has **no `"type": "module"`**, and imports have **no `.js` extensions** (`import app from "./app"`).

## Decision: ESM or CommonJS?

With `module: NodeNext`, a package without `"type": "module"` compiles to CommonJS, so the extensionless imports work today.
Adding `"type": "module"` makes every relative import need a `.js` extension (about 25 files).

- **Recommended: stay CommonJS.** Zero code changes, and nothing in the stack needs ESM. Skip step 4's `"type"` line.
- **Switch to ESM only if wanted.** Add `"type": "module"`, then change every relative import to end in `.js` (e.g. `./app.js`), then run `typecheck`.

## Steps

1. [x] Install packages: `npm i -D typescript tsx @types/node @types/express @types/cors` (done).
2. [x] `tsconfig.json` in place (done; no `tsc --init` needed).
3. [x] Scripts in `package.json` (done).
4. [ ] Decide ESM vs CommonJS (above).
5. [x] Run `npm run typecheck`: passes with no errors.
6. [x] `/health` added to `src/app.ts`:
   ```ts
   app.get("/health", (_req, res) => res.json({ status: "ok" }));
   ```
7. [x] Verified (typecheck, build, `node dist/server.js` and `tsx src/server.ts` all return `{"status":"ok"}` on `/health`):
   ```
   npm run dev          # GET http://localhost:8081/health -> {"status":"ok"}  (port comes from .env / PORT)
   npm run typecheck
   npm run build
   npm start
   ```

## Done when

- `typecheck` and `build` pass with no errors.
- `/health` returns `{"status":"ok"}` from both `dev` and `start`.

## Notes

- The starter snippets default to port 3000; this project's compose file uses 8081. Use whatever `PORT` is set to.
- The earlier full hackathon plan is kept in `plan-build.md`.
