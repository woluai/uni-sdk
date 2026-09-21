import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
};

function exportTargets(exports: Record<string, unknown>): string[] {
  const files: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("./") && value !== "./package.json") {
      files.push(value);
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) walk(nested);
    }
  };
  walk(exports);
  return [...new Set(files)];
}

const TARGETS = exportTargets(pkg.exports);
const DIST_ENTRY = join(ROOT, "dist", "index.browser.js");

describe("package.json exports resolve from committed dist/", () => {
  if (!existsSync(DIST_ENTRY)) {
    test.skip("dist/ not built yet — run `bun run build`", () => {});
    return;
  }

  test("every export target exists on disk", () => {
    const missing = TARGETS.filter((rel) => !existsSync(join(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  test("root, ./app, and ./logos subpaths import", async () => {
    const root = await import(join(ROOT, "dist", "index.browser.js"));
    expect(typeof root.UnifiedAI).toBe("function");

    const app = await import(join(ROOT, "dist", "app", "index.js"));
    expect(typeof app.safeRegisterActions).toBe("function");
    expect(typeof app.makeOpenArtifactAdapter).toBe("function");

    const logos = await import(join(ROOT, "dist", "logos", "index.js"));
    expect(typeof logos.getProviderLogo).toBe("function");
  });

  test("browser, node, and app bundles expose usage analytics", async () => {
    for (const entry of ["index.browser.js", "node/index.js", "app/index.js"]) {
      const sdk = await import(join(ROOT, "dist", entry));
      expect(sdk.calculateUsagePace(
        { used: 25, limit: 100, startsAt: 0, resetsAt: 240_000 },
        { now: 120_000 },
      )).toMatchObject({ status: "ahead", projectedUsed: 50 });
      expect(sdk.aggregateUsageHistory([], { now: 120_000, days: 1 })).toMatchObject({
        tokens: 0,
        days: [{ tokens: 0 }],
      });
    }
  });

  test("file: install without lifecycle scripts resolves documented subpaths", () => {
    const staged = mkdtempSync(join(tmpdir(), "uni-sdk-pkg-"));
    const consumer = mkdtempSync(join(tmpdir(), "uni-sdk-consumer-"));
    try {
      // Mimic a GitHub clone of tracked files only: package.json + dist, no src.
      // Force prepare to fail so this test would go red if bun ran it.
      const stagedPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      stagedPkg.scripts.prepare = "exit 1";
      writeFileSync(join(staged, "package.json"), JSON.stringify(stagedPkg, null, 2));
      cpSync(join(ROOT, "dist"), join(staged, "dist"), { recursive: true });

      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "uni-sdk-consumer",
          type: "module",
          dependencies: { "@unifiedai/sdk": `file:${staged}` },
        }),
      );

      // `--ignore-scripts` is what Bun does for untrusted git deps.
      const install = Bun.spawnSync(["bun", "install", "--ignore-scripts"], {
        cwd: consumer,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(install.exitCode).toBe(0);

      const probe = Bun.spawnSync(
        [
          "bun",
          "-e",
          'import { UnifiedAI } from "@unifiedai/sdk";' +
            'import { safeRegisterActions } from "@unifiedai/sdk/app";' +
            'import { getProviderLogo } from "@unifiedai/sdk/logos";' +
            'console.log(["ok", typeof UnifiedAI, typeof safeRegisterActions, typeof getProviderLogo].join(" "));',
        ],
        { cwd: consumer, stdout: "pipe", stderr: "pipe" },
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString()).toContain("ok function function function");
    } finally {
      rmSync(staged, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
