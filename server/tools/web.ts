/**
 * `fetch_url` — full HTTP client built on the global `fetch` (Node 22+).
 * Supports any method, custom headers, and a request body. Returns the
 * status, headers, and a body that's auto-classified as text/JSON/HTML.
 * Cap: 5 MiB response body to keep the model context bounded; 30s default
 * timeout (configurable). Read-only — no approval needed.
 */

import type { ToolDefinition } from "../tools.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * True if `addr` is a public, routable address. False for anything the model
 * could use to probe internal infrastructure: loopback, private RFC1918,
 * link-local (incl. cloud metadata 169.254.169.254), multicast, IPv6 ULA,
 * IPv6 link-local, IPv6 unique-local. We also treat the unspecified and
 * broadcast addresses as private.
 */
export function isPublicAddress(addr: string): boolean {
  // IPv4
  const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return false;                       // 10.0.0.0/8
    if (a === 127) return false;                      // 127.0.0.0/8 (loopback)
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false;         // 192.168.0.0/16
    if (a === 169 && b === 254) return false;         // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 0) return false;                        // 0.0.0.0/8
    if (a >= 224 && a <= 239) return false;           // 224.0.0.0/4 (multicast)
    if (a >= 240) return false;                       // 240.0.0.0/4 (reserved/broadcast)
    return true;
  }
  // IPv6 — handle the common literal forms.
  // Strip zone IDs (e.g. fe80::1%eth0) and bracket wrappers.
  const v6 = addr.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (v6 === "::1" || v6 === "::") return false; // loopback + unspecified
  if (v6.startsWith("fc") || v6.startsWith("fd")) return false; // fc00::/7 unique-local
  if (v6.startsWith("fe80:") || v6.startsWith("fe8") ||
      v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
    return false;                                  // fe80::/10 link-local
  }
  if (v6.startsWith("ff")) return false;          // ff00::/8 multicast
  return true;
}

/**
 * Resolve `parsed.hostname` and refuse if the result (or the hostname
 * itself) is a private / loopback / metadata address. Returns an error
 * string on refusal, or `null` when the URL is safe to fetch.
 *
 * Why resolve DNS: a hostile model could pass `http://attacker.com` whose
 * A record points at `127.0.0.1` or `169.254.169.254`. Blocking only the
 * literal hostname misses that vector.
 */
async function assertPublicHost(parsed: URL): Promise<string | null> {
  const host = parsed.hostname;
  if (!host) return "URL must include a hostname";
  // Literal IPv4 or bracketed IPv6 hostname — check directly.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) {
    return isPublicAddress(host)
      ? null
      : `refusing to fetch private address: ${host}`;
  }
  // Hostname is a name — DNS-resolve and check every returned address.
  let addrs: string[];
  try {
    const { promises: dns } = await import("node:dns");
    const recs = await dns.lookup(host, { all: true, verbatim: true });
    addrs = recs.map((r) => r.address);
  } catch (err) {
    return `could not resolve ${host}: ${(err as Error).message}`;
  }
  if (addrs.length === 0) return `no addresses for ${host}`;
  for (const a of addrs) {
    if (!isPublicAddress(a)) {
      return `refusing to fetch ${host} — resolves to private address ${a}`;
    }
  }
  return null;
}

function classifyAndDecode(raw: string, contentType: string): { kind: string; body: string } {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return { kind: "json", body: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch {
      return { kind: "text", body: raw };
    }
  }
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    // Light HTML → text: collapse runs of blank lines, drop script/style.
    const stripped = raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .trim();
    return { kind: "html-text", body: stripped };
  }
  return { kind: "text", body: raw };
}

const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description:
    "Make an HTTP request to `url` and return the response. Default method is GET. Optional `headers` (object) and `body` (string) are sent on POST/PUT/PATCH. The response body is auto-classified as JSON (pretty-printed) or HTML (tags stripped, text only). Body is capped at 5 MiB; response is truncated if larger. Timeout defaults to 30s (configurable via `timeout_ms`). Read-only — no approval needed.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute URL to fetch. Only http: and https: are allowed." },
      method: {
        type: "string",
        description: "HTTP method. Default GET.",
      },
      headers: {
        type: "object",
        description: "Additional request headers as {key: value}.",
      },
      body: {
        type: "string",
        description: "Request body (used for POST/PUT/PATCH).",
      },
      timeout_ms: {
        type: "number",
        description: "Override the default 30s timeout. Min 1s, max 5 min.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  preview: (args) => {
    const m = String(args.method ?? "GET");
    const u = typeof args.url === "string" ? args.url : "?";
    return `${m} ${u}`;
  },
  execute: async (args) => {
    try {
      const url = String(args.url ?? "");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return `Error: invalid URL: ${url}`;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `Error: only http: and https: URLs are supported`;
      }
      // SSRF guard: refuse requests to private / link-local / loopback / metadata
      // addresses so the model can't probe the local network or cloud metadata
      // endpoints. Localhost-on-localhost is fine in dev, but the same code path
      // would be dangerous if anyone ever bound the server to 0.0.0.0. The
      // hostnames "localhost", "127.0.0.0/8", "::1", "169.254.0.0/16" (cloud
      // metadata), "10/8", "172.16/12", "192.168/16", "fc00::/7", and
      // "fe80::/10" are all blocked regardless of whether the URL was
      // constructed via IP literal or DNS resolution. We resolve the hostname
      // once before fetching and reject if any returned address is private.
      const ssrfError = await assertPublicHost(parsed);
      if (ssrfError) {
        return `Error: ${ssrfError}`;
      }
      const method = (String(args.method ?? "GET")).toUpperCase();
      const headers = (args.headers && typeof args.headers === "object" ? args.headers : {}) as Record<string, string>;
      const body = args.body !== undefined ? String(args.body) : undefined;
      const timeoutMs = Math.min(
        Math.max(Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS), 1_000),
        5 * 60_000,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined && method !== "GET" && method !== "HEAD" ? body : undefined,
          signal: controller.signal,
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }
      const contentType = res.headers.get("content-type") ?? "";
      const reader = res.body?.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      let truncated = false;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > MAX_BODY_BYTES) {
            truncated = true;
            // Keep the first chunk up to the cap; drop the rest.
            const overshoot = received - MAX_BODY_BYTES;
            if (value.byteLength > overshoot) {
              chunks.push(value.subarray(0, value.byteLength - overshoot));
            }
            // Drain the rest of the stream so the connection can close.
            while (true) {
              const next = await reader.read();
              if (next.done) break;
            }
            break;
          }
          chunks.push(value);
        }
      }
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const raw = chunks.map((c) => decoder.decode(c, { stream: true })).join("");
      const tail = decoder.decode();
      const decoded = classifyAndDecode(raw + tail, contentType);
      const headerObj: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerObj[k] = v;
      });
      const out = {
        status: res.status,
        ok: res.ok,
        contentType: headerObj["content-type"] ?? "",
        finalUrl: res.url,
        headers: headerObj,
        body: decoded.body,
        bodyKind: decoded.kind,
        bytes: received,
        truncated,
      };
      return JSON.stringify(out, null, 2);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  },
};

export const webTools: ToolDefinition[] = [fetchUrlTool];
