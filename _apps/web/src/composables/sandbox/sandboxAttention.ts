import type { IconName } from "@intentic-app/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { useMissingSecretCount } from "../secrets/useSecrets";
import { useEnvironment } from "./useEnvironment";
import { useSandboxVersion } from "./useSandboxVersion";

/* WHAT THE ACTIVE SANDBOX NEEDS FROM ITS OWNER — one list, read by the rail's sandbox chip and the mobile
 * menu, so both say the same things in the same order.
 *
 * Two of these used to be full-width bars above every view, and a bar is the wrong instrument for all four:
 * none is urgent enough to interrupt, each is a standing CONDITION rather than an event, and a bar carrying a
 * dismiss × while its condition still holds teaches the reader to dismiss the next one unread. They are
 * ambient status, so they live where ambient status lives — a badge on the thing they are about (the sandbox),
 * with the sentences one click into the popover that badge sits on.
 *
 * The chip has to be the one to carry them because the /sandbox hub owns all four and has no rail tile: a fact
 * that is invisible until you already know to go looking is the failure the bars were built to fix, and a
 * badge fixes it at a hundredth of the cost. */

export interface SandboxAttentionItem {
    // The glyph for this item's popover row — and, for the top item, for the chip's badge. Both env items wear
    // the warning triangle their bars wore: the two are one errand on one tab, and their rows say which.
    readonly icon: IconName;
    // `warning` is something the user is carrying that will bite (a half-applied capability, a failing deploy);
    // `info` is optional. Nothing here is ever `danger` — none of it means BROKEN, it means UNFINISHED.
    readonly tone: "warning" | "info";
    // The whole fact, phrased to stand alone in a popover row AND to read as a clause when the chip's tooltip
    // joins several of them after the sandbox name. No trailing period, like every other badge tooltip.
    readonly message: string;
    // The tab that resolves it. Several items can share one (both env items do) — the tab sorts them out.
    readonly to: string;
    // Set only where the amount is the message: how many secrets are missing decides how long the errand is.
    // The others are one click each, so a number beside them would be read in the unit this one established.
    readonly count?: number;
}

export function useSandboxAttention() {
    const { pending, proposal } = useEnvironment();
    const { updateAvailable } = useSandboxVersion();
    const { missingRequiredCount } = useMissingSecretCount();

    /* Declared worst-first: the head decides what the badge wears, and the whole list is what the popover
     * shows. Rebuild leads because it is work the user already approved and left half-applied; the proposal
     * behind it is a decision not yet made; secrets are only ever felt at deploy time; and the update sits last
     * as the one item nothing breaks without. */
    const items = computed<readonly SandboxAttentionItem[]>(() => [
        ...(pending.value === undefined
            ? []
            : [
                  {
                      icon: `exclamation-triangle` as const,
                      tone: `warning` as const,
                      message: `Rebuild needed to finish setting up your new capabilities`,
                      to: `/sandbox/environment`,
                  },
              ]),
        ...(proposal.value === undefined
            ? []
            : [
                  {
                      icon: `exclamation-triangle` as const,
                      tone: `warning` as const,
                      message: `The agent proposed a change to your environment`,
                      to: `/sandbox/environment`,
                  },
              ]),
        ...(missingRequiredCount.value === 0
            ? []
            : [
                  {
                      icon: `key` as const,
                      tone: `warning` as const,
                      message: `${missingRequiredCount.value} required secret${missingRequiredCount.value === 1 ? `` : `s`} missing`,
                      to: `/sandbox/secrets`,
                      count: missingRequiredCount.value,
                  },
              ]),
        ...(updateAvailable.value
            ? [
                  {
                      icon: `arrow-circle-up` as const,
                      tone: `info` as const,
                      message: `A new sandbox version is available`,
                      to: `/sandbox`,
                  },
              ]
            : []),
    ]);

    // ONE chip states ONE thing (see ViewBadge): the head item's shape — its count where the amount is the
    // message, its glyph otherwise — and every sentence in the tooltip, which is the only place a second
    // pending item is sayable without a second badge.
    const badge = computed<ViewBadge | undefined>(() => {
        const [head] = items.value;
        if (head === undefined) {
            return undefined;
        }
        return {
            ...(head.count === undefined ? { mark: head.icon } : { count: head.count }),
            tone: head.tone,
            tooltip: items.value.map((item) => item.message).join(` · `),
        };
    });

    return { items, badge };
}
