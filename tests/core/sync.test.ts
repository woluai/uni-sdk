import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import {
  type SnapshotBackend,
  type SyncTiming,
  WorkspaceSync,
  encodeSnapshot,
} from "../../src/resources/sync";
import { FakeSyncServer } from "../../src/testing";

const NS = "app";
const COL = "notes";

function makeSdk(server: FakeSyncServer, backend?: SnapshotBackend): UnifiedAI {
  return new UnifiedAI({
    apiUrl: server.baseUrl,
    token: "t",
    fetch: server.fetch as unknown as typeof fetch,
    ...(backend ? { sync: backend } : {}),
  });
}

/** In-memory SnapshotBackend double with call counters. */
class MemSnapshotBackend implements SnapshotBackend {
  readonly store = new Map<string, Uint8Array>();
  clears = 0;
  saves = 0;
  load(workspaceId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.store.get(workspaceId) ?? null);
  }
  save(workspaceId: string, bytes: Uint8Array): Promise<void> {
    this.saves += 1;
    this.store.set(workspaceId, bytes);
    return Promise.resolve();
  }
  clear(workspaceId: string): Promise<void> {
    this.clears += 1;
    this.store.delete(workspaceId);
    return Promise.resolve();
  }
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("sdk.sync — bootstrap + delta", () => {
  test("bootstrap paging assembles the full record set across pages", async () => {
    const server = new FakeSyncServer();
    const count = 1001; // > PAGE_LIMIT (500) → forces 3 pages
    server.seed(
      "ws",
      Array.from({ length: count }, (_, i) => ({
        ns: NS,
        collection: COL,
        id: `n${i}`,
        metadata: { i },
      })),
    );
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    const rows = ws.collection(NS, COL).list();
    expect(rows).toHaveLength(count);
    expect(ws.collection(NS, COL).get("n0")?.metadata.i).toBe(0);
    expect(ws.collection(NS, COL).get("n1000")?.metadata.i).toBe(1000);
    expect(server.requestCount).toBeGreaterThan(1); // multiple bootstrap pages
    await ws.stop();
  });

  test("delta applies changes in order", async () => {
    const server = new FakeSyncServer();
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    expect(ws.collection(NS, COL).list()).toHaveLength(0);

    server.applyOps("ws", [{ ns: NS, collection: COL, id: "a", replace: { v: 1 } }]);
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);

    server.applyOps("ws", [{ ns: NS, collection: COL, id: "a", replace: { v: 2 } }]);
    server.applyOps("ws", [{ ns: NS, collection: COL, id: "b", replace: { v: 9 } }]);
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(2);
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(9);
    await ws.stop();
  });

  test("tombstone via delta removes the local record", async () => {
    const server = new FakeSyncServer();
    server.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]);
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")).not.toBeNull();

    server.remove("ws", NS, COL, "a");
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")).toBeNull();
    expect(ws.collection(NS, COL).list()).toHaveLength(0);
    await ws.stop();
  });
});

describe("sdk.sync — optimistic apply", () => {
  test("apply is visible immediately, before the POST resolves", async () => {
    const server = new FakeSyncServer();
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    const p = ws.apply([{ ns: NS, collection: COL, id: "a", patch: { v: 1 } }]);
    // Synchronous optimistic write — visible before awaiting the network.
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    await p;
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    await ws.stop();
  });

  test("apply-echo arriving via delta is deduped (no double-notify, no regress)", async () => {
    const server = new FakeSyncServer();
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    let fires = 0;
    ws.collection(NS, COL).subscribe(() => {
      fires += 1;
    });
    await ws.apply([{ ns: NS, collection: COL, id: "a", patch: { v: 1 } }]);
    expect(fires).toBe(1); // one optimistic notify
    // The applied row now arrives again via a delta poll — must be a no-op.
    await ws.sync();
    expect(fires).toBe(1);
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    await ws.stop();
  });

  test("server failure rolls every touched record back to its pre-image", async () => {
    const server = new FakeSyncServer();
    server.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]);
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();
    server.setApplyFailing(true);
    await expect(
      ws.apply([
        { ns: NS, collection: COL, id: "a", patch: { v: 2 } }, // mutate existing
        { ns: NS, collection: COL, id: "b", patch: { v: 5 } }, // create new
      ]),
    ).rejects.toBeTruthy();
    // Exact rollback: existing restored to pre-image, new record removed.
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    expect(ws.collection(NS, COL).get("b")).toBeNull();
    await ws.stop();
  });

  test("null patch value removes a metadata key — optimistically and via delta", async () => {
    const server = new FakeSyncServer();
    server.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { x: 1, y: 2 } }]);
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();

    // Optimistic: y removed synchronously.
    const p = ws.apply([{ ns: NS, collection: COL, id: "a", patch: { y: null } }]);
    expect(ws.collection(NS, COL).get("a")?.metadata).toEqual({ x: 1 });
    await p;
    expect(ws.collection(NS, COL).get("a")?.metadata).toEqual({ x: 1 });

    // Via delta: a foreign null-patch drops x too.
    server.applyOps("ws", [{ ns: NS, collection: COL, id: "a", patch: { x: null } }]);
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")?.metadata).toEqual({});
    await ws.stop();
  });
});

describe("sdk.sync — epoch reset", () => {
  test("409 clears store, calls backend.clear, re-bootstraps, notifies subscribers", async () => {
    const server = new FakeSyncServer();
    const backend = new MemSnapshotBackend();
    server.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]);
    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.sync();
    let fires = 0;
    ws.collection(NS, COL).subscribe(() => {
      fires += 1;
    });

    // A record added AFTER the current cursor, then an epoch bump.
    server.applyOps("ws", [{ ns: NS, collection: COL, id: "b", replace: { v: 2 } }]);
    server.bumpEpoch("ws");

    await ws.sync(); // delta → 409 → full reset + re-bootstrap
    expect(backend.clears).toBe(1);
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(2);
    expect(fires).toBeGreaterThanOrEqual(1); // notified with fresh post-bootstrap state
    await ws.stop();
  });
});

describe("sdk.sync — snapshots", () => {
  test("save/load round-trips through an in-memory SnapshotBackend", async () => {
    const server = new FakeSyncServer();
    const backend = new MemSnapshotBackend();
    server.seed("ws", [
      { ns: NS, collection: COL, id: "a", metadata: { v: 1 } },
      { ns: NS, collection: COL, id: "b", metadata: { v: 2 } },
    ]);
    const ws1 = makeSdk(server, backend).sync.workspace("ws");
    await ws1.sync();
    await ws1.stop(); // flushes a snapshot synchronously
    expect(backend.saves).toBeGreaterThanOrEqual(1);

    const ws2 = makeSdk(server, backend).sync.workspace("ws");
    await ws2.start(); // hydrates from the snapshot
    expect(ws2.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    expect(ws2.collection(NS, COL).get("b")?.metadata.v).toBe(2);
    await ws2.stop();
  });

  test("corrupt snapshot bytes are ignored (no throw)", async () => {
    const server = new FakeSyncServer();
    const backend = new MemSnapshotBackend();
    backend.store.set("ws", new Uint8Array([0x01, 0x02, 0x03, 0xff]));
    server.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]);
    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.start(); // must not throw over the corrupt snapshot
    await ws.sync();
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    await ws.stop();
  });

  test("snapshot for a different workspaceId is ignored", async () => {
    const server = new FakeSyncServer();
    const backend = new MemSnapshotBackend();
    // A valid snapshot, but stamped with the WRONG workspaceId.
    backend.store.set(
      "ws",
      encodeSnapshot(
        "other-ws",
        null,
        [
          {
            ns: NS,
            collection: COL,
            id: "zzz",
            metadata: { v: 99 },
            version: 1,
            deleted: false,
            syncId: 1,
            createdAt: 0,
            updatedAt: 0,
            hasBlob: false,
          },
        ],
        0,
      ),
    );
    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.start();
    await ws.sync();
    expect(ws.collection(NS, COL).get("zzz")).toBeNull(); // mismatched snapshot not applied
    await ws.stop();
  });

  test("hydrate-then-delta: snapshot rows visible synchronously, then delta updates them", async () => {
    const server = new FakeSyncServer();
    const backend = new MemSnapshotBackend();
    server.applyOps("ws", [{ ns: NS, collection: COL, id: "a", replace: { v: 1 } }]);
    const ws1 = makeSdk(server, backend).sync.workspace("ws");
    await ws1.sync();
    await ws1.stop(); // snapshot has a@{v:1} + a delta cursor

    // The server moves on past the snapshot cursor.
    server.applyOps("ws", [{ ns: NS, collection: COL, id: "a", replace: { v: 2 } }]);

    const ws2 = makeSdk(server, backend).sync.workspace("ws");
    await ws2.start();
    // Synchronously readable straight from the snapshot (stale value).
    expect(ws2.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    // Background delta catch-up brings it current.
    await ws2.sync();
    expect(ws2.collection(NS, COL).get("a")?.metadata.v).toBe(2);
    await ws2.stop();
  });
});

describe("sdk.sync — poll backoff & offline", () => {
  test("backoff ramps to the 60s cap, flips offline after 2 failures, recovers to live", async () => {
    const server = new FakeSyncServer();
    server.setOffline(true); // every bootstrap/delta fails
    const sdk = makeSdk(server);
    const captured: number[] = [];
    const timing: SyncTiming = {
      now: () => Date.now(),
      // Record each requested delay; yield on a real macrotask so the loop spins.
      sleep: (ms) =>
        new Promise<void>((r) => {
          captured.push(ms);
          setTimeout(r, 0);
        }),
    };
    const ws = new WorkspaceSync(sdk, "ws", null, { pollIntervalMs: 5000 }, timing);
    void ws.start();

    // Let the failing loop ramp until it hits (and plateaus at) the 60s cap.
    await until(() => captured.filter((d) => d === 60_000).length >= 2);
    expect(ws.status.get().state).toBe("offline");
    // The documented failing schedule: base, then doubling to the cap.
    expect(captured.slice(0, 5)).toEqual([5000, 10_000, 20_000, 40_000, 60_000]);

    // Recover: the next poll succeeds → live, and an immediate (0ms) extra poll.
    const before = captured.length;
    server.setOffline(false);
    await until(() => ws.status.get().state === "live");
    expect(captured.slice(before)).toContain(0);
    await ws.stop();
  });
});

describe("sdk.sync — listWorkspaces (discovery)", () => {
  test("returns the caller's workspaces with id, name, kind, role", async () => {
    const server = new FakeSyncServer();
    server.registerWorkspace("ws-personal", { name: "Personal", kind: "personal", role: "owner" });
    server.registerWorkspace("ws-team", { name: "Acme", kind: "team", role: "member" });

    const list = await makeSdk(server).sync.listWorkspaces();
    expect(list).toContainEqual({
      id: "ws-personal",
      name: "Personal",
      kind: "personal",
      role: "owner",
    });
    expect(list).toContainEqual({ id: "ws-team", name: "Acme", kind: "team", role: "member" });
    expect(list).toHaveLength(2);
  });
});

describe("sdk.sync — head + filtered delta", () => {
  const seedChat = (server: FakeSyncServer) =>
    server.seed("w1", [
      { ns: "chat", collection: "messages", id: "m1", metadata: { conversationId: "c1", content: "big" } },
      { ns: "notes", collection: "notes", id: "n1", metadata: { title: "x" } },
    ]);

  test("head is a cursor from which a delta sees only what came after", async () => {
    const server = new FakeSyncServer();
    seedChat(server);
    const sdk = makeSdk(server);
    const cursor = await sdk.sync.head("w1");
    expect((await sdk.sync.delta("w1", { cursor })).records).toEqual([]);

    server.applyOps("w1", [{ ns: "chat", collection: "conversations", id: "c2", patch: { title: "t" } }]);
    const page = await sdk.sync.delta("w1", { cursor });
    expect(page.records.map((r) => r.id)).toEqual(["c2"]);
    expect((await sdk.sync.delta("w1", { cursor: page.cursor })).records).toEqual([]);
  });

  test("ns narrows, thin drops the payload, tombstones have no conversationId", async () => {
    const server = new FakeSyncServer();
    const sdk = makeSdk(server);
    const cursor = await sdk.sync.head("w1");
    seedChat(server);

    const all = await sdk.sync.delta("w1", { cursor });
    expect(all.records.map((r) => r.id)).toEqual(["m1", "n1"]);

    const chat = await sdk.sync.delta("w1", { cursor, ns: "chat", thin: true });
    expect(chat.records.map((r) => [r.id, r.metadata])).toEqual([["m1", { conversationId: "c1" }]]);

    server.applyOps("w1", [{ ns: "chat", collection: "messages", id: "m1", delete: true }]);
    const gone = await sdk.sync.delta("w1", { cursor: chat.cursor, ns: "chat", thin: true });
    expect(gone.records.map((r) => [r.id, r.deleted, r.metadata])).toEqual([["m1", true, {}]]);
  });

  test("a bumped epoch answers 409", async () => {
    const server = new FakeSyncServer();
    const sdk = makeSdk(server);
    const cursor = await sdk.sync.head("w1");
    server.bumpEpoch("w1");
    await expect(sdk.sync.delta("w1", { cursor })).rejects.toMatchObject({ status: 409 });
  });
});
