import type { InvariantCheck } from "../invariants/invariants.js";
import type { WebExtHub } from "./webext-hub.js";
import type { WebExtStore } from "./webext-store.js";

/* A SOCKET THE STORE NO LONGER VOUCHES FOR IS A BROWSER THE OWNER DISCONNECTED AND THE AGENT CAN STILL DRIVE.
 *
 * The runner registry's shape exactly (runners/invariant.ts), with the stakes turned up: the socket on the
 * other end is somebody's own signed-in browser, their passkeys and their bank, and the enrollment is the only
 * thing that says the agent may act in it. The store checks the token once, at connect; the hub's map decides
 * every tool call after that. Revoking and renaming are each two calls (the store's, and the hub's disconnect
 * that "is closed by the caller"), and a caller that makes one without the other leaves a browser the owner
 * removed, or renamed, reachable under a name the store has no record of, until the person quits it. */

export interface BrowserRegistryDeps {
    readonly webexts: WebExtStore;
    readonly webextHub: WebExtHub;
}

export const owner = "webext";

export const checks = ({ webexts, webextHub }: BrowserRegistryDeps): readonly InvariantCheck[] => [
    {
        name: "live-browsers-are-enrolled",
        // Not `boot`: the hub is empty then by construction, a socket does not survive a restart.
        on: ["sweep"],
        run: async ({ fail }) => {
            const strays: string[] = [];
            for (const id of webextHub.connected()) {
                if (!(await webexts.enrolled(id))) {
                    strays.push(id);
                }
            }
            if (strays.length > 0) {
                fail(
                    `${strays.length} browser socket(s) are live for ids the enrollment store does not hold (${strays.join(", ")}): a browser the owner disconnected that the agent can still drive`,
                );
            }
        },
    },
];
