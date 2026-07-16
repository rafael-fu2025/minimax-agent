/**
 * Conversations router — `/api/conversations/*`.
 *
 * DB-backed endpoints (require `DATABASE_URL`). The index.ts entry point
 * mounts this onto the shared Express app via `mountConversationsRouter()`.
 *
 * Previously these routes were defined inline in `server/index.ts`; the
 * router split keeps the entry file focused on wiring (DB init, MCP,
 * scheduler) instead of HTTP handler logic.
 */

import express, { type Request, type Response } from "express";
import { isDbConfigured } from "../db/index.js";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateTitle,
} from "../db/conversations.js";

function requireDb(_req: Request, res: Response, next: () => void) {
  if (!isDbConfigured()) {
    res.status(503).json({ error: "database not configured" });
    return;
  }
  next();
}

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((err: Error) => {
      console.error("[api] conversation handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  };

export function mountConversationsRouter(app: express.Express): void {
  app.get(
    "/api/conversations",
    requireDb,
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const conversations = await listConversations({ limit, offset });
      res.json({ conversations });
    }),
  );

  app.post(
    "/api/conversations",
    requireDb,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as {
        id?: string;
        title?: string;
        model?: string | null;
        systemPrompt?: string | null;
      };
      if (body.id !== undefined && typeof body.id !== "string") {
        res.status(400).json({ error: "id must be a string" });
        return;
      }
      const conversation = await createConversation({
        id: body.id,
        title: body.title,
        model: body.model ?? null,
        systemPrompt: body.systemPrompt ?? null,
      });
      res.status(201).json(conversation);
    }),
  );

  app.get(
    "/api/conversations/:id",
    requireDb,
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      const conv = await getConversation(id);
      if (!conv) {
        res.status(404).json({ error: "not found" });
        return;
      }
      // Convert bigint ids to strings so JSON.stringify doesn't truncate.
      const messages = conv.messages.map((m) => ({
        ...m,
        id: m.id.toString(),
      }));
      res.json({ ...conv, messages });
    }),
  );

  app.patch(
    "/api/conversations/:id",
    requireDb,
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      const title = (req.body ?? {}).title;
      if (typeof title !== "string" || title.trim().length === 0) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const ok = await updateTitle(id, title.trim());
      if (!ok) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.delete(
    "/api/conversations/:id",
    requireDb,
    asyncHandler(async (req, res) => {
      const id = req.params.id;
      const ok = await deleteConversation(id);
      if (!ok) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.status(204).end();
    }),
  );
}
