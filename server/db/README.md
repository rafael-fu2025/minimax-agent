# Database (server/db)

Optional Postgres + Drizzle persistence for `conversations` and `messages`.

When `DATABASE_URL` is **not set**, the server runs unchanged (stateless chat
only). The new endpoints (`/api/conversations`, `/api/health/db`) return
`503 {error:"database not configured"}`, and `POST /api/chat` still works.

## Quickstart (local dev)

```sh
# 1. Start Postgres (one-off; data lives in a named Docker volume)
npm run db:up

# 2. Make sure DATABASE_URL is in .env (copy .env.example)
#    DATABASE_URL=postgres://postgres:postgres@localhost:5433/astryx

# 3. Generate + apply migrations
npm run db:generate   # writes SQL to server/db/migrations/
npm run db:migrate    # applies them to the live DB

# 4. Start the server
npm run dev
```

Other scripts:

```sh
npm run db:studio    # Drizzle Studio (web UI; usually http://localhost:4983)
npm run db:down      # Stop the container (volume is preserved)
```

## Tables

- **conversations** — one row per chat. PK is a UUID v4 string. CHECK
  constraint enforces the UUID shape on direct SQL inserts.
- **messages** — append-only log of `system`/`user`/`assistant`/`tool` rows.
  `sequence` is monotonic per conversation. `UNIQUE (conversation_id,
  sequence)` is the backstop for `appendMessage`'s row-lock + retry pattern.

Tool calls are stored as JSONB inside the parent assistant message's
`tool_calls` column — no separate `tool_invocations` table.

## Failure modes

| Situation                                              | Behaviour                                 |
|--------------------------------------------------------|-------------------------------------------|
| `DATABASE_URL` unset                                   | Lazy pool never built. New endpoints 503. |
| `DATABASE_URL` set but DB unreachable                  | `/api/health/db` returns 503 with error. `/api/chat` still streams; persistence hooks log `[persistence]` and swallow. |
| Mid-stream DB write fails                              | One `[persistence]` warning per failed hook. SSE stream is never interrupted. |
| Two concurrent `/api/chat` on same `conversationId`    | `SELECT ... FOR UPDATE` serialises them; UNIQUE-violation retry catches stragglers. |

## Operational tips

- The dev Postgres data lives in the Docker volume `astryx_pgdata`, **not**
  on the host filesystem. This is intentional — the repo lives under
  OneDrive, and bind-mounting postgres data there would trigger sync
  conflicts.
- Connection pool caps at 10. Set `DATABASE_URL` to a connection string with
  the right role/credentials (default: `postgres:postgres@localhost:5433/astryx`).
- Adding the optional `pgvector` columns next slice needs only a new
  migration; the docker image already includes the extension.
