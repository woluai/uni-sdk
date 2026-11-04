import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedAIError } from "../../src/node/index";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

interface FakeUnifiedApi {
  baseUrl: string;
  stop: () => Promise<void>;
  setResponse: (init: { status: number; body: unknown }) => void;
  lastAuth: () => string;
}

async function startFakeUnifiedApi(): Promise<FakeUnifiedApi> {
  let response: { status: number; body: unknown } = {
    status: 200,
    body: {
      object: "list",
      data: [
        {
          id: "gpt-x", type: "text", object: "model", owned_by: "acme",
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        },
        { id: "img-y", type: "image", object: "model", owned_by: "acme", created: 1700000000 },
      ],
    },
  };
  let lastAuth = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      lastAuth = req.headers.get("authorization") ?? "";
      const body =
        typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      return new Response(body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    setResponse: (init) => {
      response = init;
    },
    lastAuth: () => lastAuth,
  };
}

function makeSdk(api: FakeUnifiedApi, keychain: InMemoryKeychain): UnifiedAI {
  return new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    keychain,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async () => {},
  });
}

async function seedTokens(keychain: InMemoryKeychain): Promise<void> {
  const tokens: TokenSet = {
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh_test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: USER,
    client_id: CLIENT,
  };
  await keychain.set(CLIENT, tokens);
}

describe("sdk.models.list", () => {
  let api: FakeUnifiedApi;
  let keychain: InMemoryKeychain;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    api = await startFakeUnifiedApi();
    keychain = new InMemoryKeychain();
    await seedTokens(keychain);
    sdk = makeSdk(api, keychain);
    await sdk.bootstrap();
  });

  afterEach(async () => {
    await api.stop();
  });

  test("returns typed list and sends bearer token", async () => {
    const res = await sdk.models.list();
    expect(res.object).toBe("list");
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.id).toBe("gpt-x");
    expect(res.data[0]?.type).toBe("text");
    expect(res.data[0]?.reasoning_options).toEqual([
      { type: "effort", values: ["low", "high", "max"] },
    ]);
    expect(api.lastAuth()).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  test("non-2xx throws UnifiedAIError with status and server body", async () => {
    api.setResponse({ status: 404, body: { error: "no such resource" } });
    let caught: unknown;
    try {
      await sdk.models.list();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    const e = caught as UnifiedAIError;
    expect(e.status).toBe(404);
    expect(e.code).toBe("not_found");
    expect(e.body).toEqual({ error: "no such resource" });
  });

  test("5xx maps to server_error", async () => {
    api.setResponse({ status: 503, body: "down" });
    const p = sdk.models.list();
    await expect(p).rejects.toBeInstanceOf(UnifiedAIError);
    try {
      await p;
    } catch (err) {
      expect((err as UnifiedAIError).code).toBe("server_error");
    }
  });
});
