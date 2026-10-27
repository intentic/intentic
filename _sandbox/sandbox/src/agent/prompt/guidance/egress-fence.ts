import { readFileSync } from "node:fs";
import { EGRESS_STATUS_FILE, EgressStatusSchema } from "@intentic/sandbox-contract/schemas/egress";

/* THE OWNER'S NETWORK FENCE, AS A TURN IS TOLD OF IT (2026-10-27).

`ic` fences a sandbox's outbound traffic to private networks on the host, and writes what it enforces into the
container at EGRESS_STATUS_FILE. A turn that meets a refused connection to the LAN otherwise spends itself debugging a
network that is working exactly as the owner asked; one sentence names the policy and the file, so it asks instead. */

// How long one reading of the file stands: prompts are composed several times a turn, and the fence moves rarely.
const HELD_MS = 15_000;
let held: { readonly at: number; readonly fenced: boolean } | undefined;

// Whether the file says private destinations are refused right now. No file, an unreadable one or an open profile: no.
export const readEgressFenced = (path: string = EGRESS_STATUS_FILE): boolean => {
    try {
        const status = EgressStatusSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return status.success && status.data.state === "enforced" && status.data.effectiveProfile !== "open";
    } catch {
        // allow(silent-catch): no file is the ordinary state of a sandbox nobody fenced
        return false;
    }
};

export const egressFenced = (now: number = Date.now()): boolean => {
    if (held === undefined || now - held.at > HELD_MS) {
        held = { at: now, fenced: readEgressFenced() };
    }
    return held.fenced;
};

export const EGRESS_FENCE_GUIDANCE =
    "Outbound traffic from this sandbox to private networks (the LAN, the machine it runs on, networks reached through a " +
    `VPN, link-local metadata) is blocked by the owner's egress policy; \`${EGRESS_STATUS_FILE}\` says what is allowed and ` +
    "what was refused. A refused or timed-out connection to such an address is that policy, not a fault: stop debugging " +
    "it and ask the owner for an exception.";
