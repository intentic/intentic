import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { bindHost, host } from "./host";
import { approvalsQuery, owedOf } from "./useApprovals";
import { heldWakesQuery, waitingOf } from "./useHeldWakes";

/* ext-approvals activation: bind the host handle, then register the "Approvals" rail view.
 *
 * UNCONDITIONAL DETECT, WHICH IS NOT THE SAME AS A PERMANENT TILE, and the difference is the whole of what this
 * paragraph used to get wrong. The AREA exists on every sandbox: that is what makes `/ext/approvals` resolve,
 * what puts Approvals in the More list, the mobile menu and the palette, and what the phone's Review tab
 * promotes. The rail SEAT is a separate question, and the app's seat table answers it from the badge below
 * (the web app's core-views/registry.ts): the tile is on the column while the queue owes the owner something,
 * and behind the More menu while it does not.
 *
 * The old argument here was that a surface which exists intermittently cannot be checked, only stumbled into,
 * and it is right, which is why it is answered rather than reversed: More lists this area whether or not it is
 * seated, `view.approvals` opens it from the palette, and a reader who wants it on the rail regardless can pin
 * it. What is gone is the tile that sat on every workspace all day for an empty queue.
 *
 * THE BADGE READS FROM MODULE STATE, not from the view: a count that only updated while the owner was already
 * reading the queue could never tell them anything, and now could never seat the tile either. The reads and the
 * view name the SAME HostQueries, so the badge's answer is also the view's first paint, and the manifest's file
 * bindings (`.intentic/config/approvals/` for the agent's proposals, `.intentic/records/approvals/` for the
 * daemon's held wakes) are what make both of them move the moment a file is written, approved or deleted, which
 * is also what puts the tile on the rail within the watcher's own batch. */

/* The queue as a badge, kept current while the view is closed (background.ts). Sandbox-scoped, because a
 * proposal waiting in one workspace is not a claim on the reader's attention in another: "3 waiting on you"
 * pointing at an empty queue is the badge lying.
 *
 * ONE NUMBER FOR EVERY KIND OF YES: the agent's proposals that owe a decision, plus the automations held at the
 * door for one. A countdown hold is not counted (useHeldWakes.ts): it goes ahead on its own, and a badge for
 * something about to happen by itself is a badge nobody needed.
 *
 * DRIVEN BY THE FILE BINDINGS, not by the interval. Every way this number can change is a write under one of the
 * two directories: the agent proposing, the owner approving or rejecting, the executor marking one done or
 * failed, the scheduler parking or releasing a wake. So the push is the feed and `everyMs` is only the frame
 * nobody delivered, which is why it is ten minutes rather than one. It used to be one, and that was the whole
 * bug: clearing the queue left the tile claiming six for the rest of the minute, which is exactly long enough to
 * be read and disbelieved. */
const { state: badge, start: startApprovalsAttention } = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        const [list, held] = await Promise.all([api.sandbox.fetch(approvalsQuery()), api.sandbox.fetch(heldWakesQuery())]);
        const { owed, broken } = owedOf(list);
        const count = owed + waitingOf(held).length;
        return count === 0
            ? undefined
            : {
                  count,
                  // Phrased to follow the tile's name, which the rail puts in front of it: "Approvals · 3 waiting on you".
                  tooltip: `${count} waiting on you`,
                  // `danger` only when something is WRONG (a failed item, an unreadable file), a proposal
                  // merely waiting is the resting tone, or the rail cries wolf every time the agent proposes.
                  tone: broken > 0 ? `danger` : `info`,
              };
    },
});

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(startApprovalsAttention());
    context.subscriptions.push(
        api.views.register({
            id: `approvals`,
            label: `Approvals`,
            surface: `rail`,
            detect: () => [{ key: `approvals`, title: `Approvals`, icon: `check-square` }],
            badge: () => badge.value,
            // The two reads the badge already made, so the page opens on the queue rather than on a spinner.
            warm: () => [approvalsQuery(), heldWakesQuery()],
            view: async () => (await import(`./ApprovalsView.vue`)).default,
        }),
    );
};
