/**
 * Embeddings client. One interface; two implementations.
 *
 *   - MiniMaxEmbeddings: hits POST `${MINIMAX_BASE_URL}/embeddings` with the
 *     MiniMax-proprietary payload shape (`{model, type, texts}` -> `{vectors}`).
 *     `type="db"` for indexing, `type="query"` for retrieval (asymmetric
 *     retrieval pattern -- the embedding for the same text differs slightly
 *     depending on whether it will be stored or used as a query).
 *
 *   - StubEmbeddings: returns deterministic unit vectors of the configured
 *     dimension. Lets the rest of the stack keep running when the upstream
 *     endpoint is unreachable or when the user hasn't configured an API key.
 *     Memory retrieval quality is then random -- which is fine for tests and
 *     failure isolation, but you'll never want this in production.
 *
 * Both expose `.dim()` so the schema can be tuned to match.
 */

import "dotenv/config";
import { isPlaceholderKey } from "./keys/index.js";

export type EmbeddingType = "db" | "query";

export interface EmbeddingsProvider {
  /** Returns one vector per input text. */
  embed(texts: string[], type: EmbeddingType): Promise<number[][]>;
  /** Reported dimensionality; must match the DB column. */
  dim(): number;
}

const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1024);
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "embo-001";
const MINIMAX_BASE_URL =
  (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/+$/, "");

/* -------------------------------------------------------------------------- */
/* MiniMax provider                                                           */
/* -------------------------------------------------------------------------- */

interface MiniMaxEmbeddingsResponse {
  vectors?: number[][] | null;
  base_resp?: { status_code?: number; status_msg?: string };
  usage?: { total_tokens?: number };
}

class MiniMaxEmbeddings implements EmbeddingsProvider {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  dim(): number {
    return EMBEDDING_DIM;
  }

  async embed(texts: string[], type: EmbeddingType): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Chunk to keep request bodies small. The provider's hard cap is unknown
    // but 64 is well under any reasonable limit.
    const chunkSize = 64;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      const slice = texts.slice(i, i + chunkSize);
      const res = await fetch(`${MINIMAX_BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          type,
          texts: slice,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `MiniMax embeddings error ${res.status}: ${text || res.statusText || "unknown"}`,
        );
      }
      const json = (await res.json()) as MiniMaxEmbeddingsResponse;
      const code = json.base_resp?.status_code;
      if (code && code !== 0) {
        throw new Error(
          `MiniMax embeddings base_resp error: code=${code} message=${json.base_resp?.status_msg ?? ""}`,
        );
      }
      if (!Array.isArray(json.vectors)) {
        throw new Error(
          "MiniMax embeddings response missing 'vectors' array",
        );
      }
      out.push(...json.vectors);
    }
    return this.assertAndNormalize(out, texts.length);
  }

  /** Ensure vector dimension matches configured EMBEDDING_DIM. */
  private assertAndNormalize(vectors: number[][], expected: number): number[][] {
    return vectors.map((v, i) => {
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(
          `embedding dim mismatch: provider returned ${v.length}, configured EMBEDDING_DIM=${EMBEDDING_DIM} (index ${i})`,
        );
      }
      return v;
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Stub provider (deterministic, normalized random unit vectors)               */
/* -------------------------------------------------------------------------- */

class StubEmbeddings implements EmbeddingsProvider {
  dim(): number {
    return EMBEDDING_DIM;
  }

  async embed(texts: string[], _type: EmbeddingType): Promise<number[][]> {
    // Deterministic per text so repeated calls return the same vector --
    // makes A/B comparisons reproducible during development.
    return texts.map((t) => hashToUnitVector(t, this.dim()));
  }
}

function hashToUnitVector(text: string, dim: number): number[] {
  // FNV-1a-ish hash per dimension slot to keep determinism without pulling
  // in a crypto dep. Vectors are L2-normalized so similarity ~= cosine.
  const out = new Array<number>(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    let h = 2166136261 >>> 0;
    const seed = `${i}:${text}`;
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Map to [-1, 1].
    out[i] = ((h / 0xffffffff) * 2 - 1);
  }
  let mag = 0;
  for (const v of out) mag += v * v;
  mag = Math.sqrt(mag) || 1;
  return out.map((v) => v / mag);
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

let _instance: EmbeddingsProvider | null = null;

export function getEmbeddings(): EmbeddingsProvider {
  if (_instance) return _instance;
  // Explicit opt-out: EMBEDDING_PROVIDER=stub forces the deterministic stub
  // even when MINIMAX_API_KEY is set. Useful for local dev + tests where you
  // want the rest of the stack to run without burning embedding quota.
  if (process.env.EMBEDDING_PROVIDER === "stub") {
    _instance = new StubEmbeddings();
    console.warn(
      `[embeddings] EMBEDDING_PROVIDER=stub -- using StubEmbeddings (dim=${EMBEDDING_DIM}). Memory retrieval quality will be random.`,
    );
    return _instance;
  }
  const key = process.env.MINIMAX_API_KEY;
  // Filter out the .env.example placeholder the same way the key rotator
  // does — otherwise a fresh checkout ships with `sk-minimax-your-key-here`
  // in .env, the embeddings client would happily instantiate against it,
  // and every memory recall would 401 from the upstream API. The rotator
  // silently falls through to Stub; do the same here.
  if (key && !isPlaceholderKey(key)) {
    _instance = new MiniMaxEmbeddings(key);
    console.log(
      `[embeddings] MiniMax embeddings client active (dim=${EMBEDDING_DIM}, model=${EMBEDDING_MODEL})`,
    );
  } else if (key && isPlaceholderKey(key)) {
    _instance = new StubEmbeddings();
    console.warn(
      `[embeddings] MINIMAX_API_KEY is the .env.example placeholder -- using StubEmbeddings (dim=${EMBEDDING_DIM}). Memory retrieval quality will be random.`,
    );
  } else {
    _instance = new StubEmbeddings();
    console.warn(
      `[embeddings] MINIMAX_API_KEY not set -- using StubEmbeddings (dim=${EMBEDDING_DIM}). Memory retrieval quality will be random.`,
    );
  }
  return _instance;
}

/** For tests only. */
export function _resetEmbeddingsInstance(): void {
  _instance = null;
}

