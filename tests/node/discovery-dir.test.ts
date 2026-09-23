import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDiscoveryDir } from "../../src/node/_internal/discovery-file";

describe("defaultDiscoveryDir", () => {
  const saved = process.env.WOLUAI_ENV;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "WOLUAI_ENV");
    else process.env.WOLUAI_ENV = saved;
  });

  test.skipIf(process.platform === "win32")(
    "is ~/.woluai for prod and ~/.woluai-<env> otherwise",
    () => {
      Reflect.deleteProperty(process.env, "WOLUAI_ENV");
      expect(defaultDiscoveryDir()).toBe(join(homedir(), ".woluai"));
      process.env.WOLUAI_ENV = "prod";
      expect(defaultDiscoveryDir()).toBe(join(homedir(), ".woluai"));
      process.env.WOLUAI_ENV = "dev";
      expect(defaultDiscoveryDir()).toBe(join(homedir(), ".woluai-dev"));
      process.env.WOLUAI_ENV = "local";
      expect(defaultDiscoveryDir()).toBe(join(homedir(), ".woluai-local"));
    },
  );
});
