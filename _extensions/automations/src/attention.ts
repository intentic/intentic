import type { AutomationApproval } from "@intentic/sandbox-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { approvalsQuery, owedOf } from "./approvalsQuery";
import { host } from "./host";

/* WHAT AUTOMATIONS HAS TO SAY WHEN NOBODY IS LOOKING AT IT, and the reason it now says anything at all.
 *
 * This tile used to be permanent and silent: an area you author once and then leave alone, holding one of the
 * nine seats a laptop's rail has, every day, for a page nothing ever calls you to. The app's seat table (the
 * web app's core-views/registry.ts) now seats a tile exactly while it is badging, which is only a fair trade
 * if a surface that CAN need you is able to say so. This is that: a wake held at the door.
 *
 * A HELD WAKE IS THE ONE THING HERE THAT STOPS DEAD WITHOUT THE OWNER. Everything else an automation does is
 * either about to happen on a schedule or has already happened and is in the run log; neither is news. A
 * `requireApproval` fire is different in kind: the trigger fired, the agent is not running, and it will not run
 * until somebody says yes. That is "something happened here that you don't already know about", which is the
 * bar `ViewBadge` sets and the bar a seat on the rail now costs.
 *
 * DRIVEN BY THE FILE BINDING, not by the interval: the manifest points `.intentic/records/approvals/` at this
 * query, so a wake arriving, being approved or being rejected wakes the poll inside the watcher's own batch
 * (background.ts). `everyMs` is the frame nobody delivered, which is why it is minutes rather than seconds. */
const { state: approvals, start: startApprovalAttention } = sandboxPoll<AutomationApproval[]>({
    host,
    everyMs: 5 * 60_000,
    initial: () => [],
    read: async (api) => api.sandbox.fetch(approvalsQuery()),
});

// Started by activate() so the tile can be seated from login rather than five minutes into the session, and
// disposed with the extension.
export { startApprovalAttention };

// Read inside the host's render computed: touching `approvals` here is what repaints, and now also what seats,
// the tile.
export const automationsBadge = (): ViewBadge | undefined => {
    const owed = owedOf(approvals.value);
    if (owed.length === 0) {
        return undefined;
    }
    return {
        count: owed.length,
        // Phrased to follow the tile's name, which the rail puts in front of it: "Automations · 2 waiting for a yes".
        tooltip: `${owed.length} waiting for a yes`,
    };
};
