import type { FromNode, ParentUplinkConfig } from "@intentic/sandbox-contract/netd-wire";
import type { ParentUplinkReport } from "../../netd/netd-link.js";
import type { RunnerIdentity } from "../runner-identity.js";

/* A runner's half of its uplink to the parent (2026-11-23): what tells its netd to dial the parent (netd's parent.rs), so
   the parent can carry a person's view of this runner and a runner-slot preview down to it. Two sides meet here, in either
   order: runner mode says which parent and with which token once it has the runner's identity, and clears it when the
   parent revokes the runner (../runner-mode.ts, ../runner-link.ts); the netd door says how to tell netd and what netd reported
   (../../bootstrap/netd-door.ts). Nothing is sent before netd has reported where its uplink stands, which it does after every
   hello: a netd older than parent uplinks never does, and closes the link on a frame kind it does not know. netd keeps
   the uplink across a daemon restart, and the next daemon sends the same config, which netd takes as no change. */

export interface ParentUplink {
    // Runner mode's word: dial this parent as this runner, or nothing (revoked, or not a runner).
    readonly want: (identity: Pick<RunnerIdentity, "parentUrl" | "id" | "token"> | undefined) => void;
    // The netd door's: how to tell netd, or undefined once the link is gone.
    readonly useNetd: (tell: ((message: FromNode) => void) | undefined) => void;
    // netd's report, from the link.
    readonly heard: (report: ParentUplinkReport) => void;
    readonly connected: () => boolean;
}

export const createParentUplink = (): ParentUplink => {
    let tell: ((message: FromNode) => void) | undefined;
    // Whether this netd has reported, and so carries parent uplinks.
    let supported = false;
    let connected = false;
    let wanted: ParentUplinkConfig | undefined;
    // What netd was last told, as JSON, so the same word is not sent twice.
    let told: string | undefined;
    const send = (): void => {
        if (tell === undefined || !supported) {
            return;
        }
        const message: FromNode = wanted === undefined ? { kind: "parentUplink" } : { kind: "parentUplink", uplink: wanted };
        const said = JSON.stringify(message);
        // Nothing to stop on a netd never told to dial.
        if (said === told || (told === undefined && wanted === undefined)) {
            return;
        }
        told = said;
        tell(message);
    };
    return {
        want: (identity) => {
            wanted = identity === undefined ? undefined : { url: identity.parentUrl, runner: identity.id, token: identity.token };
            send();
        },
        useNetd: (next) => {
            tell = next;
            // A new link is a new netd's word to learn, and a new netd to tell.
            supported = false;
            told = undefined;
        },
        heard: (report) => {
            connected = report.connected;
            if (!supported) {
                supported = true;
                send();
            }
        },
        connected: () => connected,
    };
};

// This daemon's one uplink: runner mode and the netd door each reach it from their own boot step.
export const parentUplink = createParentUplink();
