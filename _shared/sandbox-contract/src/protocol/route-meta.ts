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
}

// The builder every sandbox procedure starts from, so each carries a RouteMeta and whatever it leaves out defaults.
export const procedure = oc.$meta<RouteMeta>({});
