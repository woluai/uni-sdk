/**
 * Platform config dir, one per Wolu environment: `~/.woluai` (`%APPDATA%\WoluAI` on
 * Windows) for prod, and `~/.woluai-<env>` for `WOLUAI_ENV=dev|local`. The desktop app
 * sets WOLUAI_ENV on the processes it spawns; set it yourself to reach a dev build.
 */
export declare function defaultDiscoveryDir(): string;
/**
 * Read + parse + validate a discovery JSON file. Any failure — missing file,
 * unreadable, malformed JSON, failed validation — resolves to null; discovery
 * is always best-effort and the callers fall through to the next source.
 */
export declare function readDiscoveryJson<T>(path: string, isValid: (parsed: unknown) => boolean): Promise<T | null>;
//# sourceMappingURL=discovery-file.d.ts.map