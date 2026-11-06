import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// relayClient's job is frame handling: turning a JSON WebSocket into typed
// request/response calls and per-run streams. The socket itself is faked so the
// assertions are about frames, not networking. Credential + base URL come from
// `configureLocalAgents`, same as local-agents.test.ts.

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
}
(globalThis as { localStorage?: Storage }).localStorage = makeStorage();

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  /** Drive the handshake the way the server would. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** Frames of one type, in order. */
  ofType(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

const { UnifiedAI } = await import("../../src/core/client");
const { configureLocalAgents } = await import("../../src/localAgents/config");
const { closeAllRelayHosts, connectRelayHost, knockRelayHost, postRelayPresence, relayStatus } = await import(
  "../../src/localAgents/relayClient"
);

/** The socket is opened after an awaited token fetch; let that microtask land. */
async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** An attached, approved connection plus its fake socket. */
async function attached(deviceId = "dev-1") {
  const conn = connectRelayHost(deviceId);
  await flush();
  const ws = FakeSocket.last!;
  ws.open();
  ws.deliver({
    type: "attached",
    host: { deviceId, deviceName: "Studio", capabilities: {} },
  });
  ws.deliver({ type: "approval", state: "approved" });
  return { conn, ws };
}

const realFetch = globalThis.fetch;
let knocks: string[] = [];
let knockAnswer: () => Response = () => Response.json({ online: true, socket: true });

beforeEach(() => {
  closeAllRelayHosts();
  FakeSocket.last = null;
  knocks = [];
  knockAnswer = () => Response.json({ online: true, socket: true });
  globalThis.fetch = (async (url: string) => {
    knocks.push(String(url));
    return knockAnswer();
  }) as unknown as typeof fetch;
  configureLocalAgents({
    client: new UnifiedAI({ apiUrl: "http://localhost:3141", token: "unified-token" }),
    wsBaseUrl: "http://localhost:3141/api/v1",
  });
});

afterEach(() => {
  closeAllRelayHosts();
  globalThis.fetch = realFetch;
  // `configureLocalAgents` merges into module-level state shared with every
  // other test file in this run — clear it back out so this file's client /
  // wsBaseUrl don't leak into local-agents.test.ts's own assertions.
  configureLocalAgents({ client: undefined, wsBaseUrl: undefined });
});

// Restored once the file is done — NOT per test: every test in here needs the
// fake, and a per-test restore silently hands the rest of them the real one.
process.on("beforeExit", () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
});

describe("approval gate", () => {
  test("asks for the state on attach and reflects the answer", async () => {
    const conn = connectRelayHost("dev-1");
    await flush();
    const ws = FakeSocket.last!;
    ws.open();
    ws.deliver({ type: "attached", host: { deviceId: "dev-1", deviceName: "Studio" } });

    expect(ws.ofType("approve?")).toHaveLength(1);
    expect(conn.approval.get()).toBe("unknown");
    expect(conn.host.get()?.deviceName).toBe("Studio");

    ws.deliver({ type: "approval", state: "pending" });
    expect(conn.approval.get()).toBe("pending");
    ws.deliver({ type: "approval", state: "approved" });
    expect(conn.approval.get()).toBe("approved");
  });

  test("a denial fails the waiters instead of hanging the turn", async () => {
    const conn = connectRelayHost("dev-1");
    await flush();
    const ws = FakeSocket.last!;
    ws.open();
    const pending = conn.ready(50);
    ws.deliver({ type: "approval", state: "denied" });
    await expect(pending).rejects.toThrow(/declined/i);
    expect(conn.approval.get()).toBe("denied");
  });
});

describe("request/response frames", () => {
  test("detect round-trips by id", async () => {
    const { conn, ws } = await attached();
    const promise = conn.detect();
    await flush(1);

    const sent = ws.ofType("detect")[0]!;
    expect(typeof sent.id).toBe("string");
    ws.deliver({
      type: "detect-result",
      id: sent.id,
      claudeCode: { found: true, path: "/usr/bin/claude" },
      cursor: { found: false },
    });

    expect(await promise).toEqual({
      claudeCode: { found: true, path: "/usr/bin/claude" },
      cursor: { found: false, path: null },
    });
  });

  test("cursor-models carries the format and returns the raw output", async () => {
    const { conn, ws } = await attached();
    const promise = conn.cursorModels(false);
    await flush(1);
    const sent = ws.ofType("cursor-models")[0]!;
    expect(sent.format).toBe("text");
    ws.deliver({ type: "cursor-models-result", id: sent.id, output: "auto\n" });
    expect(await promise).toBe("auto\n");
  });

  test("list-dir round-trips by id and normalizes the listing", async () => {
    const { conn, ws } = await attached();
    const promise = conn.listDir("/repo");
    await flush(1);

    const sent = ws.ofType("list-dir")[0]!;
    expect(typeof sent.id).toBe("string");
    expect(sent.path).toBe("/repo");
    ws.deliver({
      type: "list-dir-result",
      id: sent.id,
      path: "/repo",
      parent: "/",
      home: "/Users/me",
      sep: "/",
      entries: [
        { name: "app", path: "/repo/app", git: true },
        { name: "junk" }, // no path — dropped by normalization
      ],
      restricted: true,
      root: "/repo",
    });

    expect(await promise).toEqual({
      path: "/repo",
      parent: "/",
      home: "/Users/me",
      sep: "/",
      entries: [{ name: "app", path: "/repo/app", git: true }],
      restricted: true,
      // The picker anchors its breadcrumb here and offers nothing above it.
      // Normalization rebuilds the listing field by field, so a dropped `root`
      // would quietly un-anchor the fence rather than fail.
      root: "/repo",
    });
  });

  test("repo-root round-trips by id and is padded to the caller's own array", async () => {
    const { conn, ws } = await attached();
    const promise = conn.repoRoots(["/repo/a.ts", "/repo/b.ts", "/loose.txt"]);
    await flush(1);

    const sent = ws.ofType("repo-root")[0]!;
    expect(typeof sent.id).toBe("string");
    expect(sent.paths).toEqual(["/repo/a.ts", "/repo/b.ts", "/loose.txt"]);
    // Short reply on purpose: the caller indexes the result against the array it
    // passed, so a host that answers with fewer entries must not shift them.
    ws.deliver({ type: "repo-root-result", id: sent.id, roots: ["/repo", null] });

    expect(await promise).toEqual(["/repo", null, null]);
  });

  test("an empty ask never reaches the wire", async () => {
    const { conn, ws } = await attached();
    expect(await conn.repoRoots([])).toEqual([]);
    await flush(1);
    expect(ws.ofType("repo-root")).toHaveLength(0);
  });

  test("list-dir omits the path field when listing the default root", async () => {
    const { conn, ws } = await attached();
    const promise = conn.listDir();
    await flush(1);
    const sent = ws.ofType("list-dir")[0]!;
    expect(sent).not.toHaveProperty("path");
    ws.deliver({ type: "list-dir-result", id: sent.id, home: "/Users/me", sep: "/", entries: [] });
    expect((await promise).path).toBeNull();
  });

  test("an error frame rejects the matching list-dir", async () => {
    const { conn, ws } = await attached();
    const promise = conn.listDir("/forbidden");
    await flush(1);
    const sent = ws.ofType("list-dir")[0]!;
    ws.deliver({ type: "error", id: sent.id, message: "path not allowed" });
    await expect(promise).rejects.toThrow("path not allowed");
  });

  test("an error frame rejects the matching request", async () => {
    const { conn, ws } = await attached();
    const promise = conn.pickFolder();
    await flush(1);
    const sent = ws.ofType("pick-folder")[0]!;
    ws.deliver({ type: "error", id: sent.id, message: "dialog unavailable" });
    await expect(promise).rejects.toThrow("dialog unavailable");
  });
});

describe("run streaming", () => {
  test("lines and exit reach only the handlers of that runId", async () => {
    const { conn, ws } = await attached();
    const lines: string[] = [];
    let exit: unknown = null;
    await conn.startRun(
      {
        runId: "run-1",
        lane: "claude-code",
        prompt: "hi",
        model: "opus",
        resume: null,
        workspace: null,
        trustWorkspace: false,
        extraDirs: [],
        mcp: true,
      },
      { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) },
    );

    expect(ws.ofType("start")[0]).toMatchObject({ runId: "run-1", lane: "claude-code" });

    ws.deliver({ type: "line", runId: "other", line: "nope" });
    ws.deliver({ type: "line", runId: "run-1", line: '{"type":"system"}' });
    expect(lines).toEqual(['{"type":"system"}']);

    ws.deliver({ type: "exit", runId: "run-1", code: 0, canceled: false, stderr: "" });
    expect(exit).toEqual({ code: 0, canceled: false, stderr: "" });

    // The run is finished, so a late line for it is dropped rather than
    // resurrecting a settled turn.
    ws.deliver({ type: "line", runId: "run-1", line: "late" });
    expect(lines).toHaveLength(1);
  });

  test("MCP round-trips are routed per run and answered on the same socket", async () => {
    const { conn, ws } = await attached();
    const seen: unknown[] = [];
    await conn.startRun(
      {
        runId: "run-2",
        lane: "cursor",
        prompt: "hi",
        model: null,
        resume: null,
        workspace: null,
        trustWorkspace: false,
        extraDirs: [],
        mcp: true,
      },
      {
        onLine: () => {},
        onExit: () => {},
        onMcpList: (id) => seen.push({ list: id }),
        onMcpCall: (id, name, args) => seen.push({ id, name, args }),
      },
    );

    ws.deliver({ type: "mcp-list", runId: "run-2", id: "m1" });
    ws.deliver({ type: "mcp-call", runId: "run-2", id: "m2", name: "t", arguments: { a: 1 } });
    expect(seen).toEqual([{ list: "m1" }, { id: "m2", name: "t", args: { a: 1 } }]);

    conn.mcpResult("m2", { content: [], isError: false });
    expect(ws.ofType("mcp-result")[0]).toMatchObject({ id: "m2" });
  });

  test("a dropped socket ends in-flight runs rather than leaving the turn hanging", async () => {
    const { conn, ws } = await attached();
    let exit: { stderr: string } | null = null;
    await conn.startRun(
      {
        runId: "run-3",
        lane: "cursor",
        prompt: "hi",
        model: null,
        resume: null,
        workspace: null,
        trustWorkspace: false,
        extraDirs: [],
        mcp: false,
      },
      { onLine: () => {}, onExit: (e) => (exit = e as { stderr: string }) },
    );

    ws.serverClose(1006);
    expect(exit).not.toBeNull();
    expect(exit!.stderr).toMatch(/connection lost/i);
    expect(conn.connected.get()).toBe(false);
  });

  test("a 4404 past the wake window stops retrying and says the host is offline", async () => {
    const conn = connectRelayHost("dev-9");
    await flush();
    const ws = FakeSocket.last!;
    ws.open();
    FakeSocket.last = null;
    const realNow = Date.now;
    Date.now = () => realNow() + 11_000;
    try {
      ws.serverClose(4404);
    } finally {
      Date.now = realNow;
    }
    await new Promise((r) => setTimeout(r, 520));
    // No replacement socket was constructed.
    expect(FakeSocket.last).toBeNull();
    expect(conn.lastError.get()).toMatch(/offline/i);
  });

  test("close code 4403 sets approval to denied and does not retry", async () => {
    const conn = connectRelayHost("dev-10");
    await flush();
    const ws = FakeSocket.last!;
    ws.open();
    FakeSocket.last = null;
    ws.serverClose(4403);
    await flush();
    // No replacement socket was constructed.
    expect(FakeSocket.last).toBeNull();
    expect(conn.approval.get()).toBe("denied");
    expect(conn.lastError.get()).toMatch(/isn't yours/i);
  });

  test("a ready() wait on a socket that never opened blames the connection, not approval", async () => {
    const conn = connectRelayHost("dev-11");
    await flush();
    // The socket was constructed but never opened: the host never saw this
    // client, so the failure must not be reported as a refusal.
    await expect(conn.ready(5)).rejects.toThrow(/reach that computer/i);
    expect(conn.approval.get()).not.toBe("denied");
  });
});

describe("on-demand sockets", () => {
  test("knocks before connecting", async () => {
    connectRelayHost("dev-1");
    await flush();
    expect(knocks).toEqual(["http://localhost:3141/api/v1/relay/knock/dev-1"]);
    expect(FakeSocket.last).not.toBeNull();
  });

  test("an offline answer fails the waiter and opens no socket", async () => {
    knockAnswer = () => Response.json({ online: false, socket: false });
    const conn = connectRelayHost("dev-1");
    const ready = conn.ready(200);
    await expect(ready).rejects.toThrow(/offline/i);
    expect(FakeSocket.last).toBeNull();
    expect(conn.lastError.get()).toMatch(/offline/i);
  });

  test("a knock the server can't answer still tries the socket", async () => {
    knockAnswer = () => new Response("nope", { status: 500 });
    connectRelayHost("dev-1");
    await flush();
    expect(FakeSocket.last).not.toBeNull();
  });

  test("a 4404 right after a knock retries until the host opens", async () => {
    knockAnswer = () => Response.json({ online: true, socket: false });
    const conn = connectRelayHost("dev-1");
    const ready = conn.ready(5_000);
    await flush();
    const first = FakeSocket.last!;
    first.serverClose(4404);
    expect(conn.lastError.get()).toBeNull();

    await new Promise((r) => setTimeout(r, 520));
    await flush();
    const second = FakeSocket.last!;
    expect(second).not.toBe(first);
    second.open();
    second.deliver({ type: "attached", host: { deviceId: "dev-1", deviceName: "Studio" } });
    second.deliver({ type: "approval", state: "approved" });
    await ready;
    // Each attempt knocks, so a host that closed between two tries is woken again.
    expect(knocks.length).toBe(2);
  });

  test("a normal close with nobody waiting does not reconnect, and ready() reopens", async () => {
    const { conn, ws } = await attached();
    await conn.ready(100);
    ws.deliver({ type: "host-closed" });
    ws.serverClose(1000);
    // Going idle is not an error, and nothing should wake the host again.
    expect(conn.lastError.get()).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect(FakeSocket.last).toBe(ws);
    const before = knocks.length;

    const ready = conn.ready(1_000);
    await flush();
    const next = FakeSocket.last!;
    expect(next).not.toBe(ws);
    expect(knocks.length).toBe(before + 1);
    next.open();
    next.deliver({ type: "attached", host: { deviceId: "dev-1", deviceName: "Studio" } });
    next.deliver({ type: "approval", state: "approved" });
    await ready;
  });

  test("a socket lost mid-run reports it and does not reconnect on its own", async () => {
    const { conn, ws } = await attached();
    const exits: unknown[] = [];
    await conn.startRun(
      { runId: "r1", lane: "claude-code", prompt: "x", model: null, mcp: false },
      { onLine() {}, onExit: (e) => exits.push(e) },
    );
    ws.deliver({ type: "host-closed" });
    expect(conn.lastError.get()).toMatch(/offline/i);
    ws.serverClose(1000);
    expect(exits).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(FakeSocket.last).toBe(ws);
  });

  test("status and presence speak the wire", async () => {
    knockAnswer = () => Response.json({ hosts: [], chatSync: 3 });
    expect(await relayStatus()).toEqual({ hosts: [], chatSync: 3 });

    knockAnswer = () => Response.json({ wake: true, chatSync: 3, sendCapabilities: false });
    expect(await postRelayPresence({ deviceId: "dev-1" })).toEqual({
      status: 200,
      answer: { wake: true, chatSync: 3, sendCapabilities: false },
    });

    knockAnswer = () => new Response("no", { status: 403 });
    expect(await postRelayPresence({ deviceId: "dev-1" })).toEqual({ status: 403, answer: null });
    expect(await knockRelayHost("dev-1")).toBeNull();
    expect(await relayStatus()).toBeNull();
  });
});
