import { join } from "node:path";
import { defaultDiscoveryDir, readDiscoveryJson } from "./discovery-file";
import { withTimeoutSignal } from "./fetch-timeout";

// Local-first discovery of the LOCAL Ecosystem API hosting, per PROTOCOL.md
// "Local ecosystem hosting & discovery". Mirrors discovery.ts (the auth handoff
// discovery), but resolves the ecosystem loopback base URL + per-launch token and
// verifies liveness with a fail-fast /health probe. When the running desktop app is
// present, an SDK prefers this hosting (offline-capable, the only home of non-synced
// data); when absent or stale, it returns null and the caller falls back to the cloud
// hosting (UNIFIEDAI_API_URL). Node-only (node:fs) — never import from a browser bundle.

export interface EcosystemDiscoveryRecord {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly started_at: number;
}

/** The resolved local hosting: base URL + the bearer token to authenticate with. */
export interface LocalEcosystem {
  readonly baseUrl: string;
  readonly token: string;
}

export function defaultEcosystemDiscoveryPath(): string {
  return join(defaultDiscoveryDir(), "ecosystem.json");
}

function readRecord(path: string): Promise<EcosystemDiscoveryRecord | null> {
  return readDiscoveryJson<EcosystemDiscoveryRecord>(path, (parsed) => {
    const p = parsed as Partial<EcosystemDiscoveryRecord> | null;
    return typeof p?.url === "string" && typeof p?.token === "string";
  });
}

export interface DiscoverOptions {
  /** Override the discovery-file path (tests). */
  readonly path?: string;
  /** Fail-fast probe deadline; PROTOCOL suggests ~500 ms. */
  readonly timeoutMs?: number;
  /** A standalone (class-4) app's OAuth access token. When set, the anonymous discovery
   *  token is upgraded to a scoped one via POST /enroll (offline → stays anonymous). */
  readonly oauthToken?: string;
}

/** Exchange an OAuth token for a scoped class-4 local token via /enroll; null on failure. */
async function enrollLocal(
  baseUrl: string,
  oauthToken: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    return await withTimeoutSignal(timeoutMs, async (signal) => {
      const res = await fetch(`${baseUrl}/enroll`, {
        method: "POST",
        headers: { authorization: `Bearer ${oauthToken}` },
        signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: string };
      return typeof body.token === "string" ? body.token : null;
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the local Ecosystem API hosting, or null to fall back to cloud. Resolution
 * order (docs/ecosystem-local-tokens.md §8):
 *   1. **Env handoff** — `UNIFIEDAI_ECOSYSTEM_URL` + `UNIFIEDAI_ECOSYSTEM_TOKEN`. A
 *      BUNDLED app (class 3) receives a pre-scoped token from the shell at launch this
 *      way; trusted without a probe (the shell set it for this exact child process).
 *   2. **Discovery file** — read `~/.woluai/ecosystem.json` (per WOLUAI_ENV) + probe `GET <url>/health`.
 *      The file's token is the powerless anonymous identity; a standalone app (class 4)
 *      enrolls for real scopes (§9), which is a later addition.
 * A stale file (dead port) resolves to null because the probe fails — never throws.
 */
export async function discoverLocalEcosystem(
  opts: DiscoverOptions = {},
): Promise<LocalEcosystem | null> {
  // 1. Env handoff (bundled apps) — the shell injected these for this child.
  const envUrl = process.env.UNIFIEDAI_ECOSYSTEM_URL;
  const envToken = process.env.UNIFIEDAI_ECOSYSTEM_TOKEN;
  if (envUrl && envToken) {
    return { baseUrl: envUrl, token: envToken };
  }

  // 2. Discovery file + liveness probe.
  const record = await readRecord(opts.path ?? defaultEcosystemDiscoveryPath());
  if (!record) return null;

  try {
    return await withTimeoutSignal(opts.timeoutMs ?? 500, async (signal) => {
      const res = await fetch(`${record.url}/health`, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { service?: string };
      if (body?.service !== "ecosystem") return null;
      // Class-4: upgrade the powerless anonymous discovery token to a scoped one.
      if (opts.oauthToken) {
        const scoped = await enrollLocal(record.url, opts.oauthToken, opts.timeoutMs ?? 500);
        if (scoped) return { baseUrl: record.url, token: scoped };
      }
      return { baseUrl: record.url, token: record.token };
    });
  } catch {
    return null;
  }
}
