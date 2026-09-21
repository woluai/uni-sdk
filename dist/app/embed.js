// src/app/embed.ts
var MSG = "__unifiedEmbed";

class EmbedError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "EmbedError";
    if (code !== undefined)
      this.code = code;
  }
}
var seq = 0;
var pending = new Map;
var onInitCb = null;
var onThemeCb = null;
var onToolCb = null;
function chromeTokens(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && k.startsWith("--") && typeof v === "string" && v)
      out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
function post(payload) {
  parent.postMessage({ [MSG]: true, ...payload }, "*");
}
window.addEventListener("message", (e) => {
  if (e.source !== parent)
    return;
  const msg = e.data;
  if (!msg || msg[MSG] !== true)
    return;
  if (msg.t === "init") {
    onInitCb?.({
      payload: msg.payload ?? null,
      theme: msg.theme === "dark" ? "dark" : "light",
      fill: msg.fill === true,
      tokens: chromeTokens(msg.tokens)
    });
  } else if (msg.t === "theme") {
    onThemeCb?.(msg.theme === "dark" ? "dark" : "light", chromeTokens(msg.tokens));
  } else if (msg.t === "tool" && typeof msg.id === "string" && typeof msg.active === "boolean") {
    onToolCb?.(msg.id, msg.active);
  } else if (msg.t === "res" && msg.id) {
    const p = pending.get(msg.id);
    if (!p)
      return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok)
      p.resolve(msg.value);
    else
      p.reject(new EmbedError(msg.error?.message || "Host action failed", msg.error?.code));
  }
});
function request(verb, fields, timeout) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const message = verb === "call" ? `Host action "${fields.action}" timed out` : "Host fetch timed out";
      if (pending.delete(id))
        reject(new EmbedError(message, "timeout"));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      post({ ...fields, t: verb, id });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}
function call(action, params = {}) {
  return request("call", { action, params }, 20000);
}
function hostFetch(url, options = {}) {
  return request("fetch", { ...options, url }, 60000);
}
function badge(text) {
  post({ t: "badge", text });
}
function widget(items) {
  post({ t: "widget", items });
}
function resize(height) {
  post({ t: "resize", height });
}
function openFull() {
  post({ t: "open" });
}
function fail(message) {
  post({ t: "error", message });
}
function reference(ref) {
  post({ t: "reference", ref });
}
function onInit(cb) {
  onInitCb = cb;
}
function onTheme(cb) {
  onThemeCb = cb;
}
function onTool(cb) {
  onToolCb = cb;
}
function toolState(id, active) {
  post({ t: "tool", id, active });
}
function ready() {
  post({ t: "ready" });
}
export {
  widget,
  toolState,
  resize,
  reference,
  ready,
  openFull,
  onTool,
  onTheme,
  onInit,
  hostFetch,
  fail,
  call,
  badge,
  EmbedError
};

//# debugId=530611B03A33776E64756E2164756E21
//# sourceMappingURL=embed.js.map
