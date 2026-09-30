// The sandbox's proof of life, which intentic-front answers itself on the daemon's own address and never forwards to
// Node: whether Node is up, how long its event loop takes to answer the front's ping, how often the front restarted it,
// how long the container has run, and its pressure stall. The daemon's heartbeat on /events rides Node's event loop,
// so a busy sandbox and a dead one look alike from there; this route tells them apart. The Rust crate `browser-wire`
// is the definition (SandboxVitals), and wire-manifests.test.ts holds the path here to the manifest it writes.

import { z } from "zod";
import type { NodeLink, Pressure, SandboxVitals } from "../front/generated/browser-wire.js";

export type { NodeLink, Pressure, SandboxVitals };

// A plain GET any origin may read, answered by the front whatever state Node is in. The route is registered as
// `front: true` in raw-routes.ts, so the daemon serves none.
export const VITALS_PATH = "/system/vitals";

// Every state, so a new one in the Rust enum fails this file's typecheck until it is read here too.
const NODE_LINKS = { starting: "starting", up: "up", restarting: "restarting" } as const satisfies { readonly [K in NodeLink]: K };

const PressureSchema = z.object({ cpu: z.number(), memory: z.number(), io: z.number() });

// Lenient where a figure is only a detail: a lag or a pressure it cannot read is unknown, and the rest still stands.
const VitalsSchema = z.object({
    node: z.enum(NODE_LINKS),
    lagMs: z.number().nonnegative().nullable().catch(null),
    restarts: z.number().int().nonnegative(),
    uptimeS: z.number().int().nonnegative(),
    pressure: PressureSchema.nullable().catch(null),
});

// A response body as `Response.json()` hands it over: any JSON value, not yet known to be the front's answer.
type JsonBody = string | number | boolean | null | readonly JsonBody[] | { readonly [key: string]: JsonBody };

// The front's answer, or undefined for anything else: an older sandbox forwards the path to Node, which answers 404 or
// an HTML page, and an edge in between may answer for a box that is not there.
export const parseVitals = (body: JsonBody): SandboxVitals | undefined => {
    const parsed = VitalsSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
};
