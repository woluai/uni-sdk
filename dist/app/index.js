// src/app/actions/index.ts
function makeOpenArtifactAdapter(open) {
  return async (params) => {
    const p = params ?? {};
    return await open({
      objectId: typeof p.objectId === "string" ? p.objectId : "",
      ...p.fragment === undefined ? {} : { fragment: p.fragment },
      ...typeof p.kind === "string" ? { kind: p.kind } : {},
      ...typeof p.collection === "string" ? { collection: p.collection } : {}
    });
  };
}
function safeRegisterActions(appName, register) {
  try {
    register();
  } catch (err) {
    console.warn(`[${appName}] registerActions failed (standalone dev or old host):`, err);
  }
}
function requiredParam(name, hint) {
  return hint ? `${name} is required — ${hint}` : `${name} is required.`;
}
function notFound(noun, id, idSourceHint) {
  const head = `${noun} not found: ${id}.`;
  return idSourceHint ? `${head} ${idSourceHint}` : head;
}
function storageUnavailable(appName, verbPhrase) {
  return `${appName} storage is unavailable — ${verbPhrase}.`;
}
// src/app/search/index.ts
var BOUNDARY_BEFORE = /[\s\p{P}]/u;
function matchKind(haystackLower, term) {
  if (!term)
    return "none";
  let idx = haystackLower.indexOf(term);
  if (idx === -1)
    return "none";
  let sawMid = false;
  while (idx !== -1) {
    const isBoundary = idx === 0 || BOUNDARY_BEFORE.test(haystackLower[idx - 1]);
    if (isBoundary)
      return "boundary";
    sawMid = true;
    idx = haystackLower.indexOf(term, idx + 1);
  }
  return sawMid ? "mid" : "none";
}
function scoreFields(fields, terms, query) {
  const titleLower = fields.title.toLowerCase();
  const secondaryLower = (fields.secondary || "").toLowerCase();
  const bodyLower = (fields.body || "").toLowerCase();
  let score = 0;
  let allInTitle = terms.length > 0;
  for (const term of terms) {
    const titleMatch = matchKind(titleLower, term);
    if (titleMatch === "boundary")
      score += 3;
    else if (titleMatch === "mid")
      score += 1.5;
    else
      allInTitle = false;
    const secondaryMatch = matchKind(secondaryLower, term);
    if (secondaryMatch === "boundary")
      score += 1;
    else if (secondaryMatch === "mid")
      score += 0.5;
    const bodyMatch = matchKind(bodyLower, term);
    if (bodyMatch === "boundary")
      score += 0.75;
    else if (bodyMatch === "mid")
      score += 0.25;
  }
  if (allInTitle)
    score += 2;
  if (titleLower === query.toLowerCase())
    score += 5;
  return score;
}
var HINTS_FLOOR = 0.1;
function isHinted(id, hintIds, appId) {
  if (!hintIds || hintIds.length === 0)
    return false;
  return hintIds.includes(id) || hintIds.includes(`${appId}:${id}`);
}
async function queryBySearchText(collection, text, limit) {
  if (!collection)
    return [];
  return await collection.query({
    where: { searchText: { match: text } },
    orderBy: "updatedAt",
    order: "desc",
    limit
  });
}
function createLatchedFallback(label, fn) {
  let disabled = false;
  return {
    get disabled() {
      return disabled;
    },
    resetForTests() {
      disabled = false;
    },
    async run(query, limit, signal) {
      if (disabled)
        return [];
      if (signal?.aborted)
        return [];
      try {
        return await fn(query, limit);
      } catch (err) {
        disabled = true;
        console.warn(`[${label}] server-side searchText match unavailable — falling back to a widened client-side scan for this session`, err);
        return [];
      }
    }
  };
}
function toSearchHit(input) {
  const { text, textPreview } = input;
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    ...text ? { snippet: text } : {},
    score: input.score,
    updatedAt: input.updatedAt,
    ...input.projectId === undefined ? {} : { projectId: input.projectId },
    ...input.containerTitle === undefined ? {} : { containerTitle: input.containerTitle },
    ...textPreview ? { preview: { kind: "text", data: text } } : {},
    openRef: input.openRef
  };
}
function compareHits(updatedAtOf) {
  return (a, b) => b.score - a.score || updatedAtOf(b) - updatedAtOf(a);
}
// src/app/text/index.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function truncateOnWord(text, max, minKeepRatio = 0) {
  if (text.length <= max)
    return text;
  const cut = text.lastIndexOf(" ", max - 1);
  if (cut > 0 && cut >= max * minKeepRatio)
    return text.slice(0, cut).trimEnd();
  return text.slice(0, max).trimEnd();
}
function clampWithEllipsis(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
var PREVIEW_MAX = 160;
var SEARCH_TEXT_MAX = 1200;
// src/app/limits.ts
var SEARCH_PROTOCOL_VERSION = 1;
var HOST_LIMITS = {
  PER_PROVIDER_REQUEST_LIMIT: 10,
  TITLE_MAX: 200,
  SNIPPET_MAX: 300,
  CONTAINER_TITLE_MAX: 120,
  PREVIEW_MAX_BYTES: 2048,
  PER_PROVIDER_TIMEOUT_MS: 1500
};
export {
  HINTS_FLOOR,
  HOST_LIMITS,
  PREVIEW_MAX,
  SEARCH_PROTOCOL_VERSION,
  SEARCH_TEXT_MAX,
  clampWithEllipsis,
  compareHits,
  createLatchedFallback,
  escapeHtml,
  isHinted,
  makeOpenArtifactAdapter,
  matchKind,
  notFound,
  queryBySearchText,
  requiredParam,
  safeRegisterActions,
  scoreFields,
  storageUnavailable,
  toSearchHit,
  truncateOnWord
};

//# debugId=83BCFD2F4A5C6F3564756E2164756E21
//# sourceMappingURL=index.js.map
