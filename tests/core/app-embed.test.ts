import { expect, test } from "bun:test";

test("embed bridge preserves the host protocol, attribution, and request cleanup", async () => {
  const originals = new Map(
    ["window", "parent", "setTimeout", "clearTimeout"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const messages: Record<string, unknown>[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const cleared: number[] = [];
  let nextTimer = 0;
  let receive: (event: MessageEvent) => void = () => {};
  let postError: Error | undefined;
  const host = {
    postMessage(message: Record<string, unknown>, target: string) {
      if (postError) throw postError;
      expect(target).toBe("*");
      messages.push(message);
    },
  };
  const stub = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const send = (data: Record<string, unknown>, source: unknown = host) =>
    receive({ data: { __unifiedEmbed: true, ...data }, source } as MessageEvent);

  try {
    stub("parent", host);
    stub("window", {
      addEventListener(event: string, callback: typeof receive) {
        expect(event).toBe("message");
        receive = callback;
      },
    });
    stub("setTimeout", (callback: () => void, delay: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    });
    stub("clearTimeout", (id: number) => {
      cleared.push(id);
      timers.delete(id);
    });
    const embed = await import("../../src/app/embed");

    const init: unknown[] = [];
    const themes: unknown[] = [];
    const tools: unknown[] = [];
    embed.onInit((value) => init.push(value));
    embed.onTheme((theme, tokens) => themes.push([theme, tokens]));
    embed.onTool((id, active) => tools.push([id, active]));
    send({ t: "init", theme: "dark", tokens: { "--text": "white" } }, {});
    send({ t: "init", __unifiedEmbed: false });
    expect(init).toEqual([]);
    send({
      t: "init",
      theme: "dark",
      fill: true,
      tokens: { "--text": "white", text: "bad", "--empty": "", "--number": 1 },
    });
    expect(init).toEqual([
      { payload: null, theme: "dark", fill: true, tokens: { "--text": "white" } },
    ]);
    send({ t: "theme", theme: "dark", tokens: { "--bg": "black" } });
    send({ t: "theme", theme: "unknown", tokens: [] });
    expect(themes).toEqual([
      ["dark", { "--bg": "black" }],
      ["light", undefined],
    ]);
    send({ t: "tool", id: "select", active: true });
    expect(tools).toEqual([["select", true]]);

    embed.ready();
    embed.badge("42%");
    const items = [
      { icon: "usage", label: "Usage", values: [{ text: "42%", level: "calm" as const }] },
    ];
    embed.widget(items);
    embed.widget([]);
    expect(messages.splice(0)).toEqual([
      { __unifiedEmbed: true, t: "ready" },
      { __unifiedEmbed: true, t: "badge", text: "42%" },
      { __unifiedEmbed: true, t: "widget", items },
      { __unifiedEmbed: true, t: "widget", items: [] },
    ]);

    const action = embed.call<number>("getUsage", { days: 7 });
    expect(messages.at(-1)).toEqual({
      __unifiedEmbed: true,
      t: "call",
      id: "c1",
      action: "getUsage",
      params: { days: 7 },
    });
    expect(timers.get(nextTimer)?.delay).toBe(20_000);
    send({ t: "res", id: "c1", ok: true, value: 99 }, {});
    expect(timers.size).toBe(1);
    send({ t: "res", id: "c1", ok: true, value: 42 });
    expect(await action).toBe(42);
    expect(timers.size).toBe(0);

    const options = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: "{}",
      maxAge: 60,
    };
    const fetch = embed.hostFetch("https://api.example.com/usage", options);
    expect(messages.at(-1)).toEqual({
      __unifiedEmbed: true,
      t: "fetch",
      id: "c2",
      url: "https://api.example.com/usage",
      ...options,
    });
    expect(timers.get(nextTimer)?.delay).toBe(60_000);
    const response = { status: 429, body: "Slow down", age: 12 };
    send({ t: "res", id: "c2", ok: true, value: response });
    expect(await fetch).toEqual(response);
    expect(timers.size).toBe(0);

    const denied = embed.hostFetch("https://api.example.com/usage");
    expect(messages.at(-1)).toEqual({
      __unifiedEmbed: true,
      t: "fetch",
      id: "c3",
      url: "https://api.example.com/usage",
    });
    send({ t: "res", id: "c3", ok: false, error: { code: "E_DENIED", message: "Not allowed" } });
    const error = await denied.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(embed.EmbedError);
    expect(error).toMatchObject({ code: "E_DENIED", message: "Not allowed" });
    expect(timers.size).toBe(0);

    const timedOut = embed.call("getUsage");
    const timer = timers.get(nextTimer)!;
    timers.delete(nextTimer);
    timer.callback();
    expect(await timedOut.catch((err: unknown) => err)).toMatchObject({
      code: "timeout",
      message: 'Host action "getUsage" timed out',
    });
    const clearCount = cleared.length;
    send({ t: "res", id: "c4", ok: true });
    expect(cleared.length).toBe(clearCount);

    postError = new Error("Cannot clone payload");
    expect(await embed.call("getUsage").catch((err: unknown) => err)).toBe(postError);
    expect(timers.size).toBe(0);
    expect(cleared.length).toBe(clearCount + 1);
    send({ t: "res", id: "c5", ok: true });
    expect(cleared.length).toBe(clearCount + 1);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
