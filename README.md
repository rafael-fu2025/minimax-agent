# Astryx × MiniMax Agent

### Built with

<div align="center">

  ![MIT License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)
  ![Node >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white)
  ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)
  ![React 19](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)
  ![Vite 6](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=FFD62E)
  ![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)
  ![PostgreSQL 16](https://img.shields.io/badge/Postgres-16%2Bpgvector-336791?style=flat-square&logo=postgresql&logoColor=white)
  ![Vitest](https://img.shields.io/badge/Vitest-2.x-6E9F18?style=flat-square&logo=vitest&logoColor=yellow)
  ![Astryx](https://img.shields.io/badge/UI-Astryx-1877F2?style=flat-square)
  ![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-compatible-0098A5?style=flat-square)

</div>

An agentic chatbot with a streaming UI built on [**Astryx**](https://github.com/facebook/astryx) — Meta's open-source React + StyleX design system — and a small Express backend that talks to [**MiniMax**](https://platform.minimax.io/) via its OpenAI-compatible Chat Completions API. The app also ships with a sidebar **Workspace Explorer** that lets you browse, create, rename, upload, and delete files in the same sandbox the agent uses — every destructive action is reversible via an **Undo** toast.

The agent has access to a native toolset of **26 tools** grouped by area. The full inventory is in [Tools](#tools); the most-used defaults are:

| Tool              | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `get_current_time`| Returns the current date/time (optional timezone + strftime pattern).   |
| `calculate`       | Safely evaluates an arithmetic expression.                              |
| `write_file`      | Write/append a UTF-8 file. Creates parent dirs.                         |
| `exec_command`    | Run a shell command in the sandbox root.                                |
| `web_search`      | Hosted DuckDuckGo results via the [MiniMax MCP](#mcp).                  |

You see the tool invocations rendered inline as the agent works.

## Stack

- **Vite + React 19 + TypeScript** — frontend
- **Astryx** (`@astryxdesign/core`, `@astryxdesign/theme-neutral`) — `ChatLayout`, `ChatMessageList`, `ChatMessage`, `ChatMessageBubble`, `ChatToolCalls`, `ChatComposer`, `Avatar`, `StatusDot`, `Timestamp`, `Dialog`, `ToastHost`, `TreeList`, `IconButton`
- **Express + node-fetch streaming** — backend
- **MiniMax-M3** — chat model (OpenAI-compatible endpoint)
- **Postgres 16 (pgvector) + Drizzle ORM** — optional server-side persistence and vector memory (see [Database](#database-optional), [Memory](#memory-optional))
- **Tool layer** — file system + terminal tools with sandboxing, plus an MCP client for plugging in external tool servers (see [Tools](#tools))

## Setup

```bash
# 1. install dependencies
npm install

# 2. add your MiniMax API key
cp .env.example .env
# then edit .env and set MINIMAX_API_KEY

# 3. run both server and web dev server
npm run dev
```

- Frontend: <http://localhost:5173>
- Backend:  <http://localhost:8787/api/health>

## Get a MiniMax API key

Visit <https://platform.minimax.io/user-center/basic-information/interface-key>, create a key, and paste it into `.env`.

## How the agent loop works

```mermaid
flowchart LR
  Browser["Browser<br/>(Astryx UI)"] -- "POST /api/chat" --> Loop
  Loop -- "SSE: text / tool_call /<br/>tool_result / done" --> Browser
  Loop -- "/v1/chat/completions" --> M3["MiniMax M3"]
  M3 -- "stream chunks" --> Loop
  Loop -- "execute" --> Tools
  subgraph Tools ["Local tools (26 native + MCP)"]
    direction TB
    FS["Filesystem<br/>fs / file-ops / archive / pdf"]
    Shell["Shell & runtime<br/>exec_command / run_python"]
    Search["Search & code<br/>code_search / format_code"]
    System["System & git<br/>list_processes / git_query"]
    Media["Media<br/>image_generate / transcribe_audio"]
    BUILT["Built-ins<br/>get_current_time / calculate"]
    MCP["MCP servers<br/>(e.g. web_search)"]
  end
  Tools -- "JSON result" --> Loop

  classDef upstream fill:#1877f2,color:#fff,stroke:#1877f2
  classDef model fill:#7c3aed,color:#fff,stroke:#7c3aed
  classDef tools fill:#f5f5f5,color:#111827,stroke:#9ca3af
  class Browser upstream
  class M3 model
  class FS,Shell,Search,System,Media,BUILT,MCP tools
```

The server keeps an agentic loop alive until the model emits an assistant message **without** `tool_calls` (or it hits a safety cap of 6 rounds). Tool outputs are fed back into the conversation so the model can react.

## SSE event protocol

`POST /api/chat` returns `Content-Type: text/event-stream` with newline-delimited JSON:

```
data: {"type":"text","delta":"Hi"}
data: {"type":"text","delta":" there"}
data: {"type":"tool_call","id":"call_1","name":"get_current_time","arguments":"{}"}
data: {"type":"tool_result","id":"call_1","name":"get_current_time","output":"Current time: ..."}
data: {"type":"done","finishReason":"stop"}
```

`{"type":"error","message":"..."}` is emitted on any failure.

## Project layout

```
.
├── server/
│   ├── index.ts        # Express app + routes
│   ├── agent.ts        # Streaming agent loop (SSE; DB-agnostic)
│   ├── persistence.ts  # Persistence contract (hooks) + safe wrapper
│   ├── minimax.ts      # OpenAI-compatible MiniMax client
│   ├── tools.ts        # Tool registry (time, calc, search)
│   └── db/             # Optional Postgres + Drizzle layer
│       ├── schema.ts        # conversations / messages table defs
│       ├── index.ts         # lazy pg Pool + shutdown hook
│       ├── conversations.ts # repository (with row-lock + retry)
│       ├── migrate.ts       # standalone migration runner
│       ├── migrations/      # generated SQL (committed)
│       └── README.md
├── src/
│   ├── main.tsx        # React entry
│   ├── providers.tsx   # Astryx Theme wrapper
│   ├── App.tsx         # Chat UI built from Astryx primitives
│   ├── api.ts          # fetch + SSE consumer
│   ├── conversations.ts# Client-side localStorage multi-chat store
│   ├── defaults.ts
│   ├── types.ts        # Shared UI / event types
│   └── styles.css      # Astryx CSS + tiny app chrome
├── docker-compose.yml  # Postgres 16 + pgvector, named volume
├── drizzle.config.ts
├── index.html
├── vite.config.ts
└── package.json
```

## Swapping the model

Set `MINIMAX_MODEL` in `.env`. The default `MiniMax-M3` is recommended for tool use. Other available models include `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.1`, `MiniMax-M2`.

## Database (optional)

The server can run **stateless** (default) or with **server-side conversation persistence** behind Postgres + Drizzle. Without `DATABASE_URL`, nothing changes — the new endpoints return `503 {error:"database not configured"}`.

### Enable locally

```bash
npm run db:up          # docker compose up -d postgres (pgvector/pgvector:pg16)
cp .env.example .env   # add DATABASE_URL=postgres://postgres:postgres@localhost:5433/astryx
npm run db:generate    # writes SQL to server/db/migrations/
npm run db:migrate     # applies them
npm run dev            # server now logs "DATABASE_URL is set — persistence is enabled"
```

See [server/db/README.md](server/db/README.md) for details on the schema, the row-level lock used to serialize concurrent appends, and the failure-isolation rules.

### REST endpoints (DB must be configured)

| Method | Path                       | Notes                                                  |
|--------|----------------------------|--------------------------------------------------------|
| GET    | `/api/conversations`       | `limit` (1-200, default 50), `offset`. Ordered by `updated_at` desc. |
| POST   | `/api/conversations`       | Body `{id?, title?, model?, systemPrompt?}`. Returns the new row (`201`). |
| GET    | `/api/conversations/:id`   | Row + messages in `sequence` order. `404` if absent.    |
| PATCH  | `/api/conversations/:id`   | Body `{title}`. `404` if absent.                       |
| DELETE | `/api/conversations/:id`   | Cascade-deletes messages. `204` on success.            |
| GET    | `/api/health/db`           | DB-specific readiness; `503` when unconfigured.        |

`POST /api/chat` also accepts an optional `conversationId`. When present and the DB is configured, every user message, assistant turn, and tool result is persisted best-effort; failures log as `[persistence] ...` warnings but never interrupt the SSE stream.

## Memory (optional)

When the DB is configured and `MINIMAX_API_KEY` is set, the agent gets a **vector memory** layer: every persisted user/assistant message is embedded via `POST ${MINIMAX_BASE_URL}/embeddings` (model `embo-001`, asymmetric `query`/`db` types) and stored in a `memories` table with an HNSW cosine-distance index. On every `POST /api/chat`, the latest user message is used to recall the top-5 similar memories (across all conversations) and inject them as a "relevant prior context" block into the system prompt — so the model remembers prior context across chats without you having to repeat yourself.

Failure isolation: if the embeddings endpoint errors or is rate-limited, the call logs as `[memory] ...` and the chat continues without recall. If `MINIMAX_API_KEY` is unset, the server falls back to a deterministic stub provider so the rest of the stack still runs (recall quality is then random).

### Embedding config

| Env var            | Default     | Purpose                                              |
|--------------------|-------------|------------------------------------------------------|
| `EMBEDDING_MODEL`  | `embo-001`  | MiniMax embeddings model id.                         |
| `EMBEDDING_DIM`    | `1024`      | Vector dimension; must match the model's output.     |

If you change `EMBEDDING_DIM`, drop the memories table and re-run migrations:

```bash
npm run db:down && docker volume rm astryx_pgdata
npm run db:up && npm run db:migrate
```

### Backfilling embeddings

For any persisted messages missing memory rows, run:

```bash
npm run db:reindex
```

Idempotent and resumable — uses `message_id` as the upsert key, so re-running after a model swap is safe.

## Workspace Explorer

A live file-tree sidebar shares the same sandbox the agent operates on. Use it to peek at what the agent wrote, manually edit a file, or pre-stage the workspace before a long run.

**Mutation toolbar:**

- **New file / New folder / Upload** create entries in the active root (or under the selected directory once row-level actions land).
- **Refresh** re-fetches the tree from the server.
- The active sandbox root can be changed by clicking the folder label at the top, or via the `TOOL_SANDBOX_ROOT` env var.

**Trash & Undo:**

Every delete is a rename into a sibling `.trash/` directory inside the sandbox. A sticky toast with an **Undo** button is pushed for 8 seconds after each delete; clicking it calls `POST /api/sandbox/restore` and moves the entry back. Undo fails with `409` if the original location is now occupied by a non-empty directory.

**Hidden internals:** the `.trash/` directory is filtered out of the rendered tree so the UI does not show the recycle bin. The directory still exists on disk so Undo continues to work.

**Sandbox REST endpoints (mounted under `/api/sandbox/`):**

| Method   | Path          | Body / query                                      | Result                                                                                  |
|----------|---------------|--------------------------------------------------|-----------------------------------------------------------------------------------------|
| `GET`    | `/tree`       | `?path=&depth=`                                   | `{ path, nodes, truncated }` — recursive listing.                                       |
| `GET`    | `/file`       | `?path=&max_bytes=`                               | `{ path, content, size, truncated }` — UTF-8, capped at 64 KiB by default.               |
| `GET`    | `/root`       | —                                                | `{ root, isDefault, platform }`                                                         |
| `POST`   | `/root`       | `{ path }`                                        | `{ root, isDefault: false, platform }`                                                  |
| `POST`   | `/mkdir`      | `{ path, recursive? }`                           | `{ path }`                                                                              |
| `POST`   | `/rename`     | `{ from, to }`                                    | `{ from, to }`                                                                          |
| `DELETE` | `/file`       | `{ path }`                                        | `{ path, trashPath }` — moves into `.trash/` so the call is reversible.                  |
| `POST`   | `/upload`     | raw binary body, `?path=`                         | `{ path, bytes }` — parent dirs auto-created; capped at 50 MiB.                         |
| `POST`   | `/restore`    | `{ trashPath, originalPath }`                     | `{ path }` — moves back out of `.trash/`. `409` if `originalPath` is a non-empty dir.   |

All paths are resolved through the same `resolveSafePath` canary the agent tools use, so absolute paths, `..` traversal, and symlinks pointing outside the root all return `400`.

## Tools

The agent ships with **26 native tools**, all exposed via OpenAI-compatible function calling. They are registered through `server/tools.ts` and its submodules. The complete inventory, grouped by area:

### Filesystem

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `read_file`           | Read a UTF-8 text file (up to 256 KiB; fall back to `search_files` for larger).           |
| `write_file`          | Write/append a UTF-8 file. Creates parent dirs.                                           |
| `delete_file`         | Delete a file in the sandbox (prefer `move_file` when reversibility matters).             |
| `list_dir`            | List entries in a directory.                                                               |
| `search_files`        | Glob walk a directory (`**`, `*`, `?`, `[abc]`).                                          |
| `create_directory`    | Create a directory (recursive).                                                           |
| `move_file`           | Move or rename a file/directory. Both paths relative.                                     |
| `patch_file`          | Apply a unified diff to a file.                                                           |
| `diff_files`          | Unified diff between two files (capped at 50 KiB each).                                   |

### Shell & runtime

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `exec_command`        | Run a shell command in the sandbox root. Timeout 30s (hard cap 5 min).                   |
| `run_python`          | Run a Python source string (or a file in the sandbox) under the system Python.            |

### Search & code intelligence

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `code_search`         | ripgrep-style content search; capped at 500 matches.                                     |
| `format_code`         | Run a code formatter (prettier / black / gofmt / etc.) on a file.                         |

### Documents & archives

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `archive_zip`         | Zip a directory into a `.zip` inside the sandbox.                                         |
| `archive_unzip`       | Extract a `.zip` into a target directory.                                                 |
| `pdf_read`            | Read text from a PDF (first 50 pages by default, cap 1000).                               |
| `image_generate`      | Generate an image from a prompt via the MiniMax image API; saves PNG into the sandbox.    |
| `transcribe_audio`    | Transcribe an audio file via an OpenAI-compatible Whisper endpoint.                       |

### System & scheduler

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `list_processes`      | Cross-platform process listing (`tasklist` / `ps`).                                       |
| `kill_process`        | Kill a process by PID. Refuses PID 0 / 1 / self.                                          |
| `env_get`             | Read a single env var (or list all); redacts `*key*`/`*token*`/`*secret*`/`*password*`.  |
| `schedule_task`       | One-shot or recurring tool call (`in <n>s|m|h` / `every …` / cron).                       |
| `git_query`           | Read-only git in a repo dir: `status`, `diff`, `log`.                                     |

### Built-ins

| Tool                  | What it does                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `get_current_time`    | Current date/time (optional IANA timezone + strftime).                                    |
| `calculate`           | Safe arithmetic evaluation.                                                               |

Web search is **not** a native tool — it's provided exclusively by the [MiniMax MCP](https://platform.minimax.io/docs/token-plan/mcp-guide). Wire `MCP_SERVERS` (see [MCP](#mcp)) and the agent gets `mcp_minimax_web_search` plus whatever else the MCP server exposes.

### Sandbox

All file tools and `exec_command` are scoped to a single root:

```bash
TOOL_SANDBOX_ROOT=./workspace   # default
```

Paths must be **relative** to the sandbox root. Absolute paths, `..` traversal, and symlinks pointing outside the root are rejected at the API.

`exec_command` runs with `cwd = SANDBOX_ROOT` and a per-call timeout (default 30s, hard cap 5 min). stdout/stderr are byte-capped to 1 MiB / 256 KiB.

### Blocklist

Destructive patterns are blocked by default; the tool returns `{"exitCode":137,"stderr":"blocked by safety rule: ..."}` without spawning the process. Extend via `TOOL_EXEC_BLOCKLIST` (newline-separated regexes).

| Default pattern                                | What it catches               |
|------------------------------------------------|-------------------------------|
| `rm -rf /` (and similar)                       | wipe root                     |
| `:(){ :|:& };:`                                | classic fork bomb             |
| `mkfs*`                                        | filesystem format             |
| `dd of=/dev/sd*`                               | raw disk write                |
| `shutdown`, `reboot`, `halt`, `poweroff`, `init 0` | system power               |
| `sudo`                                         | privilege escalation          |
| `curl\|sh`, `wget\|sh`                         | remote shell script           |

### MCP

Plug in any [Model Context Protocol](https://modelcontextprotocol.io) server via the `MCP_SERVERS` env:

```bash
MCP_SERVERS='[{"name":"minimax","command":"uvx","args":["minimax-coding-plan-mcp","-y"],"env":{"MINIMAX_API_KEY":"…","MINIMAX_API_HOST":"https://api.minimax.io","MINIMAX_MCP_BASE_PATH":"C:\\…\\mcp-out"}}]'
```

Each tool is registered as `mcp_<server>_<tool>` and dispatched to the corresponding client. Empty/unset → no MCP servers boot. A reference fixture is at [server/tools/mcp.fixture.mjs](server/tools/mcp.fixture.mjs) (echo + add tools) for testing the integration without needing a real upstream MCP.

#### Recommended: MiniMax Web Search MCP

MiniMax ships a hosted `web_search` MCP server. Wire it as above and the agent gets `mcp_minimax_web_search` (in addition to the native `web_search` fallback). Set `MINIMAX_MCP_BASE_PATH` to a writable directory on your machine — the MCP uses it to stage responses.

Prerequisites:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Verify
which uvx            # or (Get-Command uvx).source on Windows
```

Your API key needs a [Token Plan seat or purchased credits](https://platform.minimax.io/user-center/payment/token-plan) for the MCP to work.

## Permission modes

Tools are gated by a three-position mode selector in the composer. The selector and the approval modal are wired into the same `permissionMode` state owned by `App.tsx`:

- **safe** — every mutating tool call (`write_file`, `exec_command`, etc.) prompts the user with a modal that shows the exact arguments before they allow it.
- **accept-edits** — `write_file` is auto-approved. `exec_command` and other non-edit tools still prompt.
- **bypass** — all tool calls auto-approve. Use with care; the modal is skipped entirely.

The mode is sent on every `POST /api/chat` so the server can short-circuit the approval queue for the modes that opt out of it.

## Tests


Unit tests are written with Vitest (no jsdom, no `@testing-library/react`). They run against a real Express app mounted on an ephemeral port for any suite that exercises HTTP routes.

```bash
npm test                # one-shot run
npm run test:watch      # watch mode
```

Notable suites:

- **`tests/server/sandbox-router.test.ts`** — 12 tests covering `mkdir`, `rename`, `delete`-to-trash with `trashPath`, restore success/failure (404 on missing, 409 on conflict), `upload` with auto-created parents, and the absolute/`..` path-canary rejections.
- **`tests/hooks/useToasts.test.ts`** — FIFO ordering, soft cap eviction, TTL behaviour, sticky behaviour at `ttlMs: 0`.
- **`tests/server/agent-loop.test.ts`** — streaming SSE end-to-end with mocked tools and the key rotator.
- **`tests/tools/web-ssrf.test.ts`** — guards against `localhost`, RFC1918, and link-local hosts in the web-search tool.

Each test file uses `vi.resetModules()` in `beforeEach` whenever it imports server modules whose state is keyed off the value of an env var (most commonly `TOOL_SANDBOX_ROOT`). Without the reset, a fresh tmp dir per test would silently point the resolver at the previous test's leftover state.

## License

MIT — built on top of [Astryx (MIT)](https://github.com/facebook/astryx).