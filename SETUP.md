# CertiFlow: Local Setup

Needs Node 20+, npm 10+, and Docker.

## Fastest path: everything in containers

```bash
cp .env.example .env     # then set JWT_SECRET (openssl rand -hex 32)
docker compose up --build
```

This starts Postgres, Redis, RabbitMQ (management UI at http://localhost:15672, login guest / guest), runs migrations and seeds the demo data, then starts the API (`http://localhost:8081`) and a worker. Scale workers with `docker compose up --scale worker=3`.

The steps below are for running the API from source.

## 1. Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env`: set `JWT_SECRET` (required; `openssl rand -hex 32`). The defaults point at the local Docker Postgres and Redis below. Never commit `.env`.

## 2. Start Postgres and Redis

```bash
docker compose up -d postgres redis rabbitmq
```

## 3. Migrate and seed demo data

```bash
npx prisma migrate deploy
npm run seed
```

Seeded personas (password `Password123!`): Anika (centre), Dev, Meera, Kabir (district officers), Neha (quality), Farah (state office). Emails are in `prisma/seed.ts`.

## 4. Run the API

```bash
npm run dev          # API on http://localhost:8081, health: GET /health
npm run dev:worker   # in a second terminal: queue consumers, sweeper, SLA scan
```

Reviewers can switch persona without a password while `DEMO_MODE=true`:

```bash
curl -X POST http://localhost:8081/api/auth/demo-login -H "Content-Type: application/json" -d '{"persona":"farah"}'
```

Set `DEMO_MODE=false` anywhere that is not a demo.

## 5. Run the tests

Tests use their own throwaway Postgres and Redis (never your `.env` database; the runner refuses non-local databases):

```bash
docker run -d --name certiflow_test_pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=certiflow_test -p 55432:5432 postgres:16-alpine
docker run -d --name certiflow_test_redis -p 56379:6379 redis:7-alpine
docker run -d --name certiflow_test_rabbit -p 56672:5672 rabbitmq:3-alpine
npm test
```

Override with `TEST_DATABASE_URL` / `TEST_REDIS_URL` / `TEST_RABBITMQ_URL` if you use other ports. The test run applies migrations and seeds by itself.

## Notes

* Typecheck: `npm run typecheck`. Build: `npm run build`.
