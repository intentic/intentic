import type { NetdHeader } from "@intentic/sandbox-contract/netd-wire";

/* WHICH WAY A REQUEST CAME IN. netd marks a request that arrived on the machine-published loopback port with its
listener header, valued `loopback`, and strips that header from everything arriving any other way (the tunnel, the
daemon's own port: netd proxy.rs `forwarded`). So the header is the one fact about a request's channel the daemon can
believe, and what a proof that only stands on one channel is checked against (proof-methods.ts). */

export const LISTENER_HEADER: NetdHeader = "x-intentic-listener";

// The value netd's listener header carries on the loopback port (netd-wire `LOOPBACK_LISTENER`).
export const LOOPBACK_LISTENER = "loopback";

// The listener a request named, or undefined: any way in that is not netd's loopback port.
export type Listener = string | undefined;

export const listenerOf = (header: (name: string) => string | undefined): Listener => header(LISTENER_HEADER);

// The same, off a Fetch `Headers` (the oRPC handlers' context).
export const listenerIn = (headers: Headers): Listener => headers.get(LISTENER_HEADER) ?? undefined;
