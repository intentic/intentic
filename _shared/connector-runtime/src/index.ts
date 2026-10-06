export type { GatewayCtx } from "./context.js";
export { createDaemonClient, type DaemonClient, type DaemonState } from "./daemon.js";
export {
    type CloseReason,
    type ConnectorEntry,
    type Delivered,
    type GatewayControl,
    type GatewayHooks,
    GatewayRefusal,
    type GatewaySpec,
    deliveryErrorResponse,
    runConnectorGateway,
    type SlotView,
} from "./gateway.js";
export { type ChatRings, chatRings, type RecentKeys, recentKeys, type TypingHeartbeat, typingHeartbeat } from "./listener-memory.js";
export { createLog, type Logger } from "./log.js";
export { deliverChunked, HISTORY_LIMIT, paintReply, RECENT_KEYS_MAX, type ReplyOptions, type ReplySurface, TYPING_MAX_MS } from "./reply.js";
export { findWorkspaceRoot, readGatewayUrl } from "./workspace.js";
// Each platform's one-message ceiling, from the contract's single table (the subpath, so a gateway loads no more of
// the contract than that).
export { MESSAGE_LIMITS } from "@intentic/sandbox-contract/message-limits";
export {
    createBufferedPainter,
    createStreamingPainter,
    failureNotice,
    framePainter,
    type Painter,
    type StreamPoster,
    type StreamTuning,
} from "./painter.js";
// The wire types both ends of the listener routes speak, re-exported so a connector types its payloads without
// depending on the whole contract package itself.
export type {
    ListenerDispatchFrame,
    ListenerGatewayPhase,
    ListenerHistoryEntry,
    ListenerMessage,
    ListenerPairing,
    ListenerStatus,
} from "@intentic/sandbox-contract";
