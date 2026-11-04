// Local agent CLIs (Claude Code, Cursor) running on the user's UnifiedApp
// desktop, driven from a browser.
//
// Two transports, one surface:
//   * the loopback **agent bridge** — a page on the same machine as the desktop
//     app (`apps/desktop/docs/agent-bridge.md`), authenticated by a per-origin
//     pairing token;
//   * the cross-device **agent relay** — unified-api's WebSocket relay
//     (`apps/desktop/docs/agent-relay.md`), authenticated by the caller's own
//     unified-api credential.
//
// Everything here is BROWSER-SAFE: no `node:` builtins, no keychain, no
// framework. It is exported from the browser entry, so an external marketplace
// app running standalone at `localhost:5173` gets the same local-CLI lane the
// embedded app gets inside the desktop shell.
//
// CONSENT: nothing in this module connects, pairs, or prompts on import.
// `resolveLocalAgentSource()` is safe to call at page load — it probes the
// unauthenticated `/health` endpoint and lists relay hosts, and it will only
// activate the bridge when a pairing token for this origin ALREADY exists.
// First-time pairing raises a modal on the desktop, so it lives behind
// `connectDesktop()`, which a host must call from an explicit user action.

export {
  BRIDGE_PORTS,
  bridgeHealth,
  bridgeToken,
  clearBridgeToken,
  hasBridgeToken,
  pairBridge,
  type BridgeDetectResult,
  // ── Low-level bridge verbs ────────────────────────────────────────────────
  // `resolveLocalAgentSource()` + `runLocalAgent()` above are the surface most
  // callers want. These are the individual wire calls underneath them, exported
  // because a host that owns its OWN source switch drives them directly: the
  // UnifiedApp desktop's `src/agentCli/transport.ts` has a fourth lane (Tauri
  // IPC, when the webview IS the desktop app) that this module cannot have, so
  // it keeps its own selector and consumes these. Exporting them is what keeps
  // the wire contract single-sourced instead of hand-copied per surface.
  bridgeCursorModels,
  bridgeDetect,
  bridgeListDir,
  bridgeMcpResult,
  bridgeOrigin,
  bridgePickFolder,
  bridgeStartRun,
  bridgeStopRun,
  defaultPairName,
  discoverBridge,
  dispatchFrame,
  invalidateBridgePort,
  openRunEvents,
  type BridgeEventStream,
  type BridgeRunHandlers,
  type BridgeStartBody,
} from "./bridgeClient";

export {
  configureLocalAgents,
  localAgentsConfig,
  type LocalAgentsConfig,
} from "./config";

export {
  normalizeDirListing,
  type LocalAgentDirEntry,
  type LocalAgentDirListing,
} from "./dirListing";

export {
  listRelayHosts,
  closeAllRelayHosts,
  closeRelayHost,
  connectRelayHost,
  knockRelayHost,
  postRelayPresence,
  relayStatus,
  type ApprovalState,
  type RelayCapabilities,
  type RelayConnection,
  type RelayHost,
  type RelayHostStatus,
  type RelayPresence,
  type RelayPresenceAnswer,
  type RelayStatus,
  // The relay's own transport primitives. A HOST — the machine that executes
  // the runs — speaks the same URL and subprotocol as the client but the
  // opposite half of the contract (`/relay/host` rather than `/relay/connect`),
  // and it lives outside this module because hosting needs a real machine
  // behind it. Exporting these keeps that half from re-deriving the URL and the
  // bearer framing by hand.
  bearerSubprotocol,
  clientDeviceId,
  clientDeviceName,
  relayWsUrl,
  type RelayDetectResult,
  type RelayRunHandlers,
  type RelayStartArgs,
} from "./relayClient";

export {
  checkDesktopAvailable,
  connectDesktop,
  detectAgents,
  disconnectDesktop,
  getLocalAgentStatus,
  isDesktopConnected,
  listLocalAgentDevices,
  listLocalAgentDir,
  onLocalAgentStatusChange,
  pickWorkspaceFolder,
  refreshLocalAgentDevices,
  refreshLocalAgents,
  refreshRelayHosts,
  resolveLocalAgentSource,
  resolveSourceFor,
  setLocalAgentSource,
  _resetLocalAgentState,
  type Lane,
  type LocalAgentDetectResult,
  type LocalAgentDevice,
  type LocalAgentSource,
  type LocalAgentSourceKind,
  type LocalAgentSourcePref,
  type LocalAgentStatus,
} from "./transport";

export {
  CLAUDE_CODE_MODEL_PREFIX,
  CURSOR_MODEL_PREFIX,
  claudeCodeModelName,
  invalidateCursorModels,
  isLocalAgentModel,
  laneForModel,
  listLocalModels,
  placeholderLocalModel,
  type LocalAgentModel,
} from "./catalog";

export { runLocalAgent, type RunLocalAgentOptions } from "./run";
