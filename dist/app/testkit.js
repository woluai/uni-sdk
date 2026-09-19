// src/app/limits.ts
var HOST_LIMITS = {
  PER_PROVIDER_REQUEST_LIMIT: 10,
  TITLE_MAX: 200,
  SNIPPET_MAX: 300,
  CONTAINER_TITLE_MAX: 120,
  PREVIEW_MAX_BYTES: 2048,
  PER_PROVIDER_TIMEOUT_MS: 1500
};

// src/app/search/testkit.ts
function findHitViolations(hits, opts = {}) {
  const out = [];
  const requireSorted = opts.requireSortedByScore !== false;
  if (opts.limit !== undefined && hits.length > opts.limit) {
    out.push(`returned ${hits.length} hits for limit ${opts.limit}`);
  }
  const seen = new Set;
  hits.forEach((hit, i) => {
    const at = `hit[${i}]`;
    const nonEmpty = (field) => {
      const v = hit[field];
      if (typeof v !== "string" || v === "")
        out.push(`${at}: ${field} must be a non-empty string`);
      return typeof v === "string" ? v : "";
    };
    const id = nonEmpty("id");
    const kind = nonEmpty("kind");
    nonEmpty("title");
    if (kind && kind !== kind.toLowerCase())
      out.push(`${at}: kind "${kind}" is not lowercase`);
    if (kind && opts.kinds && !opts.kinds.includes(kind)) {
      out.push(`${at}: kind "${kind}" is not in the manifest's search.kinds`);
    }
    const key = `${kind}:${id}`;
    if (id && seen.has(key))
      out.push(`${at}: duplicate hit for ${key}`);
    seen.add(key);
    if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
      out.push(`${at}: score must be a finite number`);
    }
    if (hit.updatedAt !== undefined && (!Number.isFinite(hit.updatedAt) || hit.updatedAt <= 0)) {
      out.push(`${at}: updatedAt must be a positive epoch-ms number when present`);
    }
    if (hit.title.length > HOST_LIMITS.TITLE_MAX) {
      out.push(`${at}: title (${hit.title.length} chars) exceeds the host cap of ${HOST_LIMITS.TITLE_MAX}`);
    }
    if (hit.snippet !== undefined) {
      if (typeof hit.snippet !== "string" || hit.snippet === "") {
        out.push(`${at}: snippet, when present, must be a non-empty string`);
      } else if (hit.snippet.length > HOST_LIMITS.SNIPPET_MAX) {
        out.push(`${at}: snippet (${hit.snippet.length} chars) exceeds the host cap of ${HOST_LIMITS.SNIPPET_MAX}`);
      }
    }
    if (hit.containerTitle !== undefined && hit.containerTitle.length > HOST_LIMITS.CONTAINER_TITLE_MAX) {
      out.push(`${at}: containerTitle exceeds the host cap of ${HOST_LIMITS.CONTAINER_TITLE_MAX}`);
    }
    if (hit.preview !== undefined && !opts.allowOversizePreview) {
      const bytes = new TextEncoder().encode(JSON.stringify(hit.preview)).length;
      if (bytes > HOST_LIMITS.PREVIEW_MAX_BYTES) {
        out.push(`${at}: preview serializes to ${bytes} bytes; the host silently drops previews over ${HOST_LIMITS.PREVIEW_MAX_BYTES}`);
      }
    }
    if (hit.openRef !== undefined) {
      if (typeof hit.openRef.objectId !== "string" || hit.openRef.objectId === "") {
        out.push(`${at}: openRef.objectId must be a non-empty string`);
      }
      if (hit.openRef.action !== undefined && opts.nonMutatingActions) {
        if (!opts.nonMutatingActions.includes(hit.openRef.action)) {
          out.push(`${at}: openRef.action "${hit.openRef.action}" is not a declared non-mutating action — the host's sanitizeOpenRef would silently strip it`);
        }
      }
    }
    const prev = hits[i - 1];
    if (requireSorted && prev !== undefined && hit.score > prev.score) {
      out.push(`${at}: score ${hit.score} rises above hit[${i - 1}]'s ${prev.score} — hits must arrive in rank order`);
    }
  });
  return out;
}
async function benchmark(fn, opts = {}) {
  const runs = opts.runs ?? 30;
  const warmup = opts.warmup ?? 5;
  for (let i = 0;i < warmup; i++)
    await fn();
  const samples = [];
  for (let i = 0;i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (p) => samples[Math.min(samples.length - 1, Math.ceil(p / 100 * samples.length) - 1)];
  return {
    runs,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: at(50),
    p95: at(95),
    max: samples[samples.length - 1]
  };
}
function formatBench(name, s) {
  const ms = (v) => `${v.toFixed(2)}ms`;
  return `search-bench ${name.padEnd(28)} p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  max ${ms(s.max)}  (${s.runs} runs)`;
}
export {
  HOST_LIMITS,
  benchmark,
  findHitViolations,
  formatBench
};

//# debugId=234D1EB0BC639C7064756E2164756E21
//# sourceMappingURL=testkit.js.map
