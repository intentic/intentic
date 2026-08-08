export type { GatewayCtx } from "./context.js";
export { createDaemonClient, type DaemonClient, type DaemonState } from "./daemon.js";
export {
    type CloseReason,
    type ConnectorEntry,
    type GatewayControl,
    type GatewayHooks,
    type GatewaySpec,
    runConnectorGateway,
    type SlotView,
} from "./gateway.js";
export { createLog, type Logger } from "./log.js";
export { createBufferedPainter, createStreamingPainter, framePainter, type Painter, type StreamPoster, type StreamTuning } from "./painter.js";
// The wire types both ends of the listener routes speak, re-exported so a connector types its payloads without
// depending on the whole contract package itself.
export type { ListenerDispatchFrame, ListenerGatewayPhase, ListenerMessage, ListenerStatus } from "@intentic/sandbox-contract";
