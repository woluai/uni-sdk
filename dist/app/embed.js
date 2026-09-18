// src/app/embed.ts
var MSG = "__unifiedEmbed";
var seq = 0;
var pending = new Map;
var onInitCb = null;
var onThemeCb = null;
var onToolCb = null;
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
      fill: msg.fill === true
    });
  } else if (msg.t === "theme") {
    onThemeCb?.(msg.theme === "dark" ? "dark" : "light");
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
      p.reject(new Error(msg.error?.message || "Host action failed"));
  }
});
function call(action, params = {}) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id))
        reject(new Error(`Host action "${action}" timed out`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    post({ t: "call", id, action, params });
  });
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
  toolState,
  resize,
  reference,
  ready,
  openFull,
  onTool,
  onTheme,
  onInit,
  fail,
  call
};

//# debugId=ABC076E81F099C1764756E2164756E21
//# sourceMappingURL=embed.js.map
