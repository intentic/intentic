// The control socket between intentic-netd and the daemon. The Rust crate `netd-wire` is the definition: its types
// arrive as TypeScript in generated/, and every value here is held to the manifest it writes beside it
// (wire-manifests.test.ts), which contract.lock.json pins.

export type * from "./generated/wire.js";

// Set by intentic-netd on the daemon it spawns: where to dial the control socket, and where to serve HTTP.
export const NETD_SOCKET_ENV = "INTENTIC_NETD_SOCKET";
export const NODE_SOCKET_ENV = "INTENTIC_NODE_SOCKET";
// Also set by intentic-netd on each daemon it starts: which start this is, counted from 1 and said back in the hello, so
// netd hands the control socket to a newer start and never to a copy of the same one.
export const NODE_GENERATION_ENV = "INTENTIC_NODE_GENERATION";
// Which copy of the sandbox is speaking, set once per container start when netd can, so a daemon restarted inside one
// container stays the same copy.
export const INSTANCE_ENV = "INTENTIC_INSTANCE";

// How long either side waits for the answer to a question it asked before giving up on it.
export const ASK_PATIENCE_MS = 5000;

// A frame is this many bytes of big-endian length, then that many bytes of JSON.
export const FRAME_LENGTH_BYTES = 4;
// The largest frame either side accepts. A length past it means the stream is corrupt, never a large message, and the
// link is dropped rather than buffering toward it.
export const FRAME_MAX_BYTES = 64 * 1024 * 1024;
