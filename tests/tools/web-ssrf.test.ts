/**
 * SSRF guard — `fetch_url` (server/tools/web.ts) must refuse to fetch
 * private / loopback / metadata addresses even when the model passes
 * them as URL literals or via DNS names that resolve to private IPs.
 *
 * Why: the tool description promises "no approval needed in any mode"
 * for read-only HTTP. A single hostile or confused prompt could turn
 * that into a probe against the local network or cloud metadata
 * (169.254.169.254). The guard intercepts BEFORE the fetch.
 */
import { describe, expect, it } from "vitest";

async function getFetchUrlExecute(): Promise<
  (args: Record<string, unknown>) => Promise<string>
> {
  const mod = await import("../../server/tools/web.js");
  const tools = (mod as { webTools: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<string> }> }).webTools;
  const tool = tools.find((t) => t.name === "fetch_url");
  if (!tool) throw new Error("fetch_url tool not found");
  return tool.execute;
}

describe("fetch_url SSRF guard", () => {
  it("rejects IPv4 literals for every reserved range", async () => {
    const mod = await import("../../server/tools/web.js");
    const isPublic = (mod as { isPublicAddress: (a: string) => boolean })
      .isPublicAddress;
    expect(typeof isPublic).toBe("function");
    expect(isPublic("8.8.8.8")).toBe(true);
    expect(isPublic("1.1.1.1")).toBe(true);
    expect(isPublic("127.0.0.1")).toBe(false);
    expect(isPublic("127.255.255.254")).toBe(false);
    expect(isPublic("10.0.0.1")).toBe(false);
    expect(isPublic("172.16.0.1")).toBe(false);
    expect(isPublic("172.31.255.254")).toBe(false);
    expect(isPublic("192.168.1.1")).toBe(false);
    expect(isPublic("169.254.169.254")).toBe(false); // cloud metadata
    expect(isPublic("224.0.0.1")).toBe(false); // multicast
    expect(isPublic("255.255.255.255")).toBe(false); // broadcast
    expect(isPublic("0.0.0.0")).toBe(false);
  });

  it("rejects IPv6 literals for loopback / ULA / link-local / multicast", async () => {
    const mod = await import("../../server/tools/web.js");
    const isPublic = (mod as { isPublicAddress: (a: string) => boolean })
      .isPublicAddress;
    expect(isPublic("::1")).toBe(false);
    expect(isPublic("::")).toBe(false);
    expect(isPublic("fc00::1")).toBe(false);
    expect(isPublic("fd12:3456::1")).toBe(false);
    expect(isPublic("fe80::1")).toBe(false);
    expect(isPublic("ff02::1")).toBe(false);
    expect(isPublic("2606:4700:4700::1111")).toBe(true); // public IPv6
  });

  it("refuses the fetch when the URL hostname is a private literal", async () => {
    const execute = await getFetchUrlExecute();
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      for (const url of [
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fc00::1]/",
      ]) {
        const result = await execute({ url });
        expect(result).toMatch(/^Error: refusing to fetch/);
      }
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("refuses the fetch when DNS resolves the hostname to a private address", async () => {
    const dns = await import("node:dns");
    const origLookup = dns.promises.lookup;
    dns.promises.lookup = (async (
      hostname: string,
      opts?: { all?: boolean; verbatim?: boolean },
    ) => {
      if (hostname === "attacker.example.test") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return origLookup(hostname, opts);
    }) as typeof dns.promises.lookup;
    try {
      const execute = await getFetchUrlExecute();
      const origFetch = globalThis.fetch;
      let called = false;
      globalThis.fetch = (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const result = await execute({ url: "http://attacker.example.test/" });
        expect(result).toMatch(/resolves to private address 127\.0\.0\.1/);
        expect(called).toBe(false);
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      dns.promises.lookup = origLookup;
    }
  });

  it("allows the fetch when DNS resolves the hostname to a public address", async () => {
    const dns = await import("node:dns");
    const origLookup = dns.promises.lookup;
    dns.promises.lookup = (async (
      hostname: string,
      opts?: { all?: boolean; verbatim?: boolean },
    ) => {
      if (hostname === "public.example.test") {
        return [{ address: "93.184.216.34", family: 4 }];
      }
      return origLookup(hostname, opts);
    }) as typeof dns.promises.lookup;
    try {
      const execute = await getFetchUrlExecute();
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response("{}", { status: 200 })) as typeof fetch;
      try {
        const result = await execute({ url: "http://public.example.test/" });
        expect(result).not.toMatch(/^Error: refusing/);
        expect(result).toMatch(/"status":\s*200/);
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      dns.promises.lookup = origLookup;
    }
  });
});
