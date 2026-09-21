---
"@unifiedai/sdk": minor
---

Add provider-independent primitives for usage dashboards:

- `calculateUsagePace` projects quota consumption from explicit window boundaries.
- `aggregateUsageHistory` builds zero-filled local-calendar totals and model series from caller-supplied events.
- Export both helpers from browser, Node, and `/app` entries.
- Add `hostFetch`, `badge`, and `widget` to `/app/embed`, preserving host error codes with `EmbedError` and forwarding host theme tokens.

The embed helpers use the existing host permission, caching, and widget protocol.
No provider credential discovery, private usage endpoints, or local usage-log readers are added.
