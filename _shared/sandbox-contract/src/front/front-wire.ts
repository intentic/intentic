// The control socket between intentic-front and the daemon. The Rust crate `front-wire` is the definition: its types
// arrive as TypeScript in generated/, and every value here is held to the manifest it writes beside it
// (wire-manifests.test.ts), which contract.lock.json pins.

export type * from "./generated/wire.js";

// Set by intentic-front on the daemon it spawns: where to dial the control socket, and where to serve HTTP.
export const FRONT_SOCKET_ENV = "INTENTIC_FRONT_SOCKET";
export const NODE_SOCKET_ENV = "INTENTIC_NODE_SOCKET";

// How long either side waits for the answer to a question it asked before giving up on it.
export const ASK_PATIENCE_MS = 5000;

// A frame is this many bytes of big-endian length, then that many bytes of JSON.
export const FRAME_LENGTH_BYTES = 4;
