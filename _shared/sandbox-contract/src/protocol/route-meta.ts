import { oc } from "@orpc/contract";
import type { MemberRole } from "../schemas/shared.js";

// Every route's policy, declared beside it: how a request authenticates, which member tier and which machine
// credentials reach it, and how the daemon's outer middleware treats it. Each field has a default, so most routes
// declare nothing; the daemon's bearer, boot, timer, role-floor and grant decisions all derive from this.

// How far a control token reaches a route beyond what its floor alone gives the `read`/`drive` rungs.
// `never`: no rung; `editor`: the editor slice too; `read`: the read rung, though no GET; `land`: the land rung too.
export type ControlReach = "never" | "editor" | "read" | "land";

export interface RouteMeta {
    // `door`: the session middleware lets it through, and the handler checks its own credential or none.
    readonly auth?: "session" | "door";
    // Loaded by third-party pages: CORS reflects the caller's origin, and the route's own allowlist is the gate.
    readonly embedded?: true;
    // Answers while the boot chain is still converging; everything else waits for it.
    readonly beforeBoot?: true;
    // Held open by design, so the request timer leaves it out.
    readonly stream?: true;
    // The lowest member role that may call it. Absent: viewer for a read (GET, HEAD), maintainer for anything else.
    readonly floor?: MemberRole;
    // On a guest member's allowlist, which is the whole of what a guest reaches.
    readonly guest?: true;
    // The floor an upload aimed inside ATTACHMENTS_DIR gets instead, one a guest may also make.
    readonly attachmentFloor?: MemberRole;
    // A passkey-registration door: a proof with no passkey yet may pass the require-passkey policy.
    readonly enrolment?: true;
    // The agent token, which the CLIs on the agent's PATH carry, reaches it.
    readonly agent?: true;
    // The desktop-sync token reaches it; a `poll` refreshes the machine's heartbeat, the held-open `pipe` does not.
    readonly sync?: "poll" | "pipe";
    // Withheld from the panel token, which reaches every other route: it puts a stored credential in motion.
    readonly panel?: false;
    readonly control?: ControlReach;
    // A transfer: announced to the edge through the front (tunnel-bulk.ts), which sends it down the tunnel's bulk socket,
    // off the connection every keystroke and call waits on.
    readonly lane?: "bulk";
    // Served by intentic-front itself (_sandbox/front, term/): the daemon only answers the front's question about it.
    readonly front?: true;
}

// The floor a route gets when it declares none: a read (GET, HEAD) floors at viewer, anything else (`ALL` included) at
// maintainer, so a route nobody classified can under-serve, never over-grant.
export const defaultFloor = (method: string): MemberRole => (method === "GET" || method === "HEAD" ? "viewer" : "maintainer");

// The fields that say how a request travels, not who may send it; every other RouteMeta field decides reach.
type TransportField = "lane" | "front";

// Every field that decides who reaches a route, with its default resolved, so an absent field and a declared one read
// alike and loosening either is a changed value: what contract.lock.json records per route (`access:METHOD /path`),
// where the lock check and the push gate see it. Keyed by the interface: a RouteMeta field added above fails this
// package's typecheck until it is read here or named a TransportField.
const ACCESS = {
    auth: (meta) => meta.auth ?? "session",
    embedded: (meta) => meta.embedded === true,
    beforeBoot: (meta) => meta.beforeBoot === true,
    stream: (meta) => meta.stream === true,
    floor: (meta, method) => meta.floor ?? defaultFloor(method),
    guest: (meta) => meta.guest === true,
    attachmentFloor: (meta) => meta.attachmentFloor ?? "none",
    enrolment: (meta) => meta.enrolment === true,
    agent: (meta) => meta.agent === true,
    sync: (meta) => meta.sync ?? "none",
    panel: (meta) => meta.panel !== false,
    // `floor`: no reach of its own, the control rungs read the route's floor alone.
    control: (meta) => meta.control ?? "floor",
} as const satisfies { readonly [K in Exclude<keyof RouteMeta, TransportField>]-?: (meta: RouteMeta, method: string) => string | boolean };

export type RouteAccess = { readonly [K in keyof typeof ACCESS]: ReturnType<(typeof ACCESS)[K]> };

// One route's reach as its declaration states it, every default filled in.
export const routeAccess = (method: string, meta: RouteMeta): RouteAccess =>
    // SAFETY: every entry is one of ACCESS's own keys paired with what its reader returned, which RouteAccess spells.
    Object.fromEntries(Object.entries(ACCESS).map(([field, read]) => [field, read(meta, method)])) as RouteAccess;

// The builder every sandbox procedure starts from, so each carries a RouteMeta and whatever it leaves out defaults.
export const procedure = oc.$meta<RouteMeta>({});
