// Embedded-app entry — import from "@unifiedai/sdk/app".
//
// The one import site for everything an embedded marketplace app needs beyond
// the model surface: the host-action envelope (actions), the search-provider
// kernel (search), the text chores (text), the protocol limits (limits), and
// usage analytics, and the search provider contract types themselves. Everything here is
// browser-safe and dependency-free — nothing pulls the SDK's runtime, so an
// app's `search.js` chunk stays as small as it was when these modules were
// copy-pasted per app.
//
// Test-only companions live behind "@unifiedai/sdk/app/testkit" so they can
// never leak into a shipped chunk.

export * from "./actions/index";
export * from "./search/index";
export * from "./text/index";
export * from "./limits";
export * from "../resources/usage-analytics";

// The provider contract the host instantiates an app's search entry against.
// Types only — adds nothing to a bundle. `SearchHit` (the SDK contract type)
// and `AppSearchHit` (the structural twin `toSearchHit` returns) deliberately
// coexist under distinct names.
export type {
  SearchHints,
  SearchRequest,
  SearchPreview,
  SearchOpenRef,
  SearchHit,
  SearchProvider,
  SearchProviderContext,
  CreateSearchProvider,
} from "../resources/search/types";
