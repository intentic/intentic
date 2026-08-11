import type { ExtensionContext, IntenticApi, ViewBadge } from "@intentic/extension-api";
import { ref } from "vue";
import { bindHost } from "./host";
import { draftsQuery, owedOf } from "./useDrafts";

/* ext-drafts activation: bind the host handle, then register the "Drafts" rail view.
 *
 * PERMANENT TILE, unconditional detect — the shell's old tile made this argument and it moves here with it:
 * Drafts used to appear only once something was waiting, which made the whole area unlearnable (a surface that
 * exists intermittently cannot be checked, only stumbled into). The tile is the place; the badge is the news.
 *
 * THE BADGE POLLS FROM MODULE STATE, not from the view: a count that only updated while the owner was already
 * reading the queue could never tell them anything. The poll and the view name the SAME HostQuery, so the
 * badge's read is also the view's first paint, and the manifest's `.intentic/drafts/` file binding invalidates
 * both the moment the agent writes a proposal. */

const POLL_MS = 60_000;

const badge = ref<ViewBadge | undefined>(undefined);

const scan = async (api: IntenticApi): Promise<void> => {
    try {
        if (!api.sandbox.reachable()) {
            return;
        }
        const { owed, broken } = owedOf(await api.sandbox.fetch(draftsQuery()));
        badge.value =
            owed === 0
                ? undefined
                : {
                      count: owed,
                      // Phrased to follow the tile's name, which the rail puts in front of it: "Drafts · 3 waiting on you".
                      tooltip: `${owed} waiting on you`,
                      // `danger` only when something is WRONG (a failed post, an unreadable file) — a proposal
                      // merely waiting is the resting tone, or the rail cries wolf every time the agent drafts.
                      tone: broken > 0 ? `danger` : `info`,
                  };
    } catch {
        // A refused or mid-boot read is an ordinary first state; the next tick picks it up.
    }
};

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    const timer = setInterval(() => void scan(api), POLL_MS);
    void scan(api);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
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
