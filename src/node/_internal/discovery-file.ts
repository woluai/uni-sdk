import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Shared plumbing for the desktop-app discovery files (`desktop.json`,
// `ecosystem.json`). Node-only (node:fs) — never import from a browser bundle.

/**
 * Platform config dir, one per Wolu environment: `~/.woluai` (`%APPDATA%\WoluAI` on
 * Windows) for prod, and `~/.woluai-<env>` for `WOLUAI_ENV=dev|local`. The desktop app
 * sets WOLUAI_ENV on the processes it spawns; set it yourself to reach a dev build.
 */
export function defaultDiscoveryDir(): string {
  const env = process.env.WOLUAI_ENV?.trim();
  const suffix = env && env !== "prod" ? `-${env}` : "";
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, `WoluAI${suffix}`);
  }
  return join(homedir(), `.woluai${suffix}`);
}

/**
 * Read + parse + validate a discovery JSON file. Any failure — missing file,
 * unreadable, malformed JSON, failed validation — resolves to null; discovery
 * is always best-effort and the callers fall through to the next source.
 */
export async function readDiscoveryJson<T>(
  path: string,
  isValid: (parsed: unknown) => boolean,
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
