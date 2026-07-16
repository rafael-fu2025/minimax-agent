/**
 * Keys router — `/api/keys/*`.
 *
 * Personal-use MultiMax API key CRUD (single-tenant). Mounted onto the
 * shared Express app by `server/index.ts` via `mountKeysRouter()`.
 */

import express from "express";
import { getConfig } from "../minimax.js";
import {
  addKey,
  deleteKey,
  getBootstrapKey,
  getUsageSummary,
  listKeys,
  testKey,
  updateKey,
} from "../keys/index.js";

export function mountKeysRouter(app: express.Express): void {
  app.get("/api/keys", async (_req, res) => {
    const baseUrl = getConfig().baseUrl;
    const keys = await listKeys();
    const bootstrap = await getBootstrapKey(baseUrl);
    const pool = bootstrap ? [bootstrap, ...keys] : keys;
    res.json({
      keys: pool,
      poolSize: pool.length,
      activeCount: pool.filter((k) => k.status === "active").length,
    });
  });

  app.get("/api/keys/usage", async (_req, res) => {
    const baseUrl = getConfig().baseUrl;
    const summary = await getUsageSummary(baseUrl);
    res.json(summary);
  });

  app.post("/api/keys", async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: unknown;
      secret?: unknown;
      hint?: unknown;
    };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      res.status(400).json({ ok: false, error: "name is required" });
      return;
    }
    if (typeof body.secret !== "string") {
      res.status(400).json({ ok: false, error: "secret is required" });
      return;
    }
    const hint = typeof body.hint === "string" ? body.hint : undefined;
    const result = await addKey({
      name: body.name.trim(),
      secret: body.secret,
      hint,
    });
    res.json(result);
  });

  app.patch("/api/keys/:id", async (req, res) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as {
      name?: unknown;
      status?: unknown;
      hint?: unknown;
    };
    const patch: {
      name?: string;
      status?: "active" | "disabled";
      hint?: string | null;
    } = {};
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (body.status === "active" || body.status === "disabled")
      patch.status = body.status;
    if (typeof body.hint === "string") patch.hint = body.hint;
    if (body.hint === null) patch.hint = null;
    const result = await updateKey(id, patch);
    res.json(result);
  });

  app.delete("/api/keys/:id", async (req, res) => {
    const result = await deleteKey(req.params.id);
    res.json(result);
  });

  app.post("/api/keys/:id/test", async (req, res) => {
    const result = await testKey(req.params.id, getConfig().baseUrl);
    res.json(result);
  });
}

