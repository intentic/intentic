import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { bindHost, host } from "./host";
import { draftsQuery, owedOf } from "./useDrafts";

/* ext-drafts activation: bind the host handle, then register the "Drafts" rail view.
 *
 * UNCONDITIONAL DETECT, WHICH IS NOT THE SAME AS A PERMANENT TILE, and the difference is the whole of what this
 * paragraph used to get wrong. The AREA exists on every sandbox: that is what makes `/ext/drafts` resolve, what
 * puts Drafts in the More list, the mobile menu and the palette, and what the phone's Review tab promotes. The
 * rail SEAT is a separate question, and the app's seat table answers it from the badge below (the web app's
 * core-views/registry.ts): the tile is on the column while the queue owes the owner something, and behind the
 * More menu while it does not.
 *
 * The old argument here was that a surface which exists intermittently cannot be checked, only stumbled into,
 * and it is right, which is why it is answered rather than reversed: More lists this area whether or not it is
 * seated, `view.drafts` opens it from the palette, and a reader who wants it on the rail regardless can pin it.
 * What is gone is the tile that sat on every workspace all day for an empty queue.
 *
 * THE BADGE READS FROM MODULE STATE, not from the view: a count that only updated while the owner was already
 * reading the queue could never tell them anything, and now could never seat the tile either. The read and the
 * view name the SAME HostQuery, so the badge's answer is also the view's first paint, and the manifest's
 * `.intentic/config/drafts/` file binding is what makes both of them move the moment a draft file is written,
 * approved or deleted, which is also what puts the tile on the rail within the watcher's own batch. */

/* The queue as a badge, kept current while the view is closed (background.ts). Sandbox-scoped, because a
 * proposal waiting in one workspace is not a claim on the reader's attention in another: "3 waiting on you"
 * pointing at an empty queue is the badge lying.
 *
 * DRIVEN BY THE FILE BINDING, not by the interval. Every way this number can change is a write under
 * `.intentic/config/drafts/`: the agent proposing, the owner approving or rejecting, the publish automation
 * marking one posted or failed. So the push is the feed and `everyMs` is only the frame nobody delivered, which
 * is why it is ten minutes rather than one. It used to be one, and that was the whole bug: clearing the queue
 * left the tile claiming six for the rest of the minute, which is exactly long enough to be read and disbelieved.
 */
const { state: badge, start: startDraftsAttention } = sandboxPoll<ViewBadge | undefined>({
    host,
    everyMs: 10 * 60_000,
    initial: () => undefined,
    read: async (api) => {
        const { owed, broken } = owedOf(await api.sandbox.fetch(draftsQuery()));
        return owed === 0
            ? undefined
            : {
                  count: owed,
                  // Phrased to follow the tile's name, which the rail puts in front of it: "Drafts · 3 waiting on you".
                  tooltip: `${owed} waiting on you`,
                  // `danger` only when something is WRONG (a failed post, an unreadable file), a proposal
                  // merely waiting is the resting tone, or the rail cries wolf every time the agent drafts.
                  tone: broken > 0 ? `danger` : `info`,
              };
    },
});

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(startDraftsAttention());
    context.subscriptions.push(
        api.views.register({
            id: `drafts`,
            label: `Drafts`,
            surface: `rail`,
            detect: () => [{ key: `drafts`, title: `Drafts`, icon: `send` }],
            badge: () => badge.value,
            view: async () => (await import(`./DraftsView.vue`)).default,
        }),
    );
};
