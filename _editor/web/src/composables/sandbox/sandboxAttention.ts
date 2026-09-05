import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../chat/providerAccounts";
import { acpProviders } from "../chat/providerCatalog";
import { useMissingSecretCount } from "../secrets/useSecrets";
import { useSyncHealth } from "./useDevices";
import { useEnvironment } from "./useEnvironment";
import { useSandboxVersion } from "./useSandboxVersion";

/* WHAT THE ACTIVE SANDBOX NEEDS FROM ITS OWNER, AND WHAT IS MERELY TRUE OF IT, one list, split by `kind`, read
 * by the rail's sandbox chip and the mobile menu, so both say the same things in the same order.
 *
 * Two of these used to be full-width bars above every view, and a bar is the wrong instrument for any of them:
 * none is urgent enough to interrupt, each is a standing CONDITION rather than an event, and a bar carrying a
 * dismiss × while its condition still holds teaches the reader to dismiss the next one unread. They are
 * ambient status, so they live where ambient status lives, a badge on the thing they are about (the sandbox),
 * with the sentences one click into the popover that badge sits on.
 *
 * The chip has to be the one to carry them because the /sandbox hub owns every one of them and has no rail
 * tile: a fact that is invisible until you already know to go looking is the failure the bars were built to
 * fix, and a badge fixes it at a hundredth of the cost.
 *
 * The account item arrived here from the Overview tab's "at a glance" directory, which stated it as a row that
 * said "Ready" on every healthy sandbox. A condition is worth a permanent row only if its nominal state is
 * worth reading, and "nothing is wrong" never is, so it states itself the way the other four do, by being
 * absent until it holds. */

// Whether ANYTHING here can run a turn: a daemon-stored provider account, one of the bundled translator's own
// subscriptions, or an installed ACP agent (which is its own credential store). Read from the leaf modules
// rather than useChat, the rail must not pull the whole chat in, which is why they are leaves
// (providerAccounts.ts). Silent until the daemon has answered: "you have no account" and "we haven't asked"
// are the same empty list, and this one badges the rail, where a claim retracted a second later is worst.
const noAccountConnected = computed(
    () =>
        accountsLoaded.value &&
        acpProviders.value.length === 0 &&
        !Object.values(providerAccounts.value).some((accounts) => accounts.length > 0) &&
        !Object.values(translatorAccounts.value).some((subscriptions) => subscriptions.length > 0),
);

export interface SandboxAttentionItem {
    // The glyph for this item's popover row, and, for the top item, for the chip's badge. Both env items wear
    // the warning triangle their bars wore: the two are one errand on one tab, and their rows say which.
    readonly icon: IconName;
    // `warning` is something the user is carrying that will bite (a half-applied capability, a failing deploy);
    // `info` is optional. Nothing here is ever `danger`, none of it means BROKEN, it means UNFINISHED.
    readonly tone: "warning" | "info";
    /* WHETHER THIS IS A DEBT OR A FACT, which decides whether it may badge the chip.
     *
     * They shipped as one list under one heading that says "Needs you", and a `note` does not need you: the
     * contended port is the sandbox and the machine both working correctly while one number went to whoever
     * asked first. It cannot be dismissed, it cannot be resolved from the popover, and on a machine running two
     * sandboxes it is true every day, so it sat on the chip as a "1" that never cleared, which is the exact
     * shape that teaches a reader to stop looking at the chip. The next badge to appear there would have been
     * the one that mattered.
     *
     * A note is not hidden; it is REHOUSED. It keeps its popover row, and the count moves to the hub row that
     * explains it (SandboxHub's Devices), where the sentence and the verb both live. A badge belongs on the
     * thing it is about, and the sandbox chip is about the whole box. */
    readonly kind: "needs" | "note";
    // The whole fact, phrased to stand alone in a popover row AND to read as a clause when the chip's tooltip
    // joins several of them after the sandbox name. No trailing period, like every other badge tooltip.
    readonly message: string;
    // The tab that resolves it. Several items can share one (both env items do), the tab sorts them out.
    readonly to: string;
    // Set only where the amount is the message: how many secrets are missing decides how long the errand is.
    // The others are one click each, so a number beside them would be read in the unit this one established.
    readonly count?: number;
    /* WHETHER THIS NOTE MAY WEAR THE CHIP WHEN NO DEBT DOES — a narrow, deliberate bend of "notes never
     * badge". The rule exists because a badge that stays lit for a standing condition teaches the reader to
     * stop chasing badges; a note may set this only when acting on it is one click and seconds, so the badge
     * it earns clears as fast as a debt's would. Today exactly one note qualifies: a staged update, whose
     * whole point (the machine downloaded it in the background so the owner wouldn't have to find a button)
     * is defeated if the fact stays invisible until someone already knows to open the hub. Meaningless on a
     * `needs`, which badges anyway. */
    readonly badges?: boolean;
}

/* The update, in the two shapes it now comes in. Merely AVAILABLE stays the quiet note it always was: the
 * machine's background download (auto-prepare on the host agent) makes this state brief wherever a device
 * is connected, and nothing about it is quick to act on yet. Once it is STAGED the fact changes character —
 * the download already happened, applying it is one click and a half-minute restart on the hub card — and
 * that is the one note allowed to badge the chip (`badges` above): the whole point of downloading in the
 * background was that the owner should not have to already know to go looking. */
const updateItems = (available: boolean, staged: boolean): SandboxAttentionItem[] => {
    if (!available) {
        return [];
    }
    if (staged) {
        return [
            {
                icon: `arrow-circle-up`,
                tone: `info`,
                message: `A sandbox update is ready to apply — a restart of about half a minute`,
                to: `/sandbox`,
                kind: `note`,
                badges: true,
            },
        ];
    }
    return [{ icon: `arrow-circle-up`, tone: `info`, message: `A new sandbox version is available`, to: `/sandbox`, kind: `note` }];
};

export function useSandboxAttention() {
    const { pending, proposal } = useEnvironment();
    const { updateAvailable, updateStaged } = useSandboxVersion();
    const { missingRequiredCount } = useMissingSecretCount();
    const { stoppedOn, contendedPorts } = useSyncHealth();

    /* Declared worst-first: the head decides what the badge wears, and the whole list is what the popover
     * shows. No account leads because it is the only one that stops a turn from running at all; a rebuild is
     * work the user already approved and left half-applied; the proposal behind it is a decision not yet made;
     * secrets are only ever felt at deploy time; and the update sits last as the one item nothing breaks
     * without.
     *
     * The account item is about the SANDBOX ("nothing here can run a turn"), which is why it can sit on the
     * chip. Its narrower cousin, this conversation's provider has no credential, while another provider does,
     * stays with the composer's connect gate (ChatAccountPanel), where the choice that caused it was made. */
    const items = computed<readonly SandboxAttentionItem[]>(() => [
        ...(noAccountConnected.value
            ? [
                  {
                      icon: `sparkles` as const,
                      tone: `warning` as const,
                      message: `No AI account connected, the agent can't run a turn`,
                      to: `/sandbox/agent`,
                      kind: `needs` as const,
                  },
              ]
            : []),
        ...(pending.value === undefined
            ? []
            : [
                  {
                      icon: `exclamation-triangle` as const,
                      tone: `warning` as const,
                      message: `Rebuild needed to finish setting up your new capabilities`,
                      to: `/sandbox/environment`,
                      kind: `needs` as const,
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
                      kind: `needs` as const,
                  },
              ]),
        /* A stopped sync agent outranks the secrets below it because of how it fails: silently, and while
         * everything else keeps reading healthy. The enrollment is intact, the card says "Enabled", and the
         * user's edits simply stop travelling. This is the one item here whose absence used to cost days. */
        ...(stoppedOn.value.length === 0
            ? []
            : [
                  {
                      icon: `desktop` as const,
                      tone: `warning` as const,
                      message: `Desktop sync stopped on ${stoppedOn.value.join(`, `)}, its folder isn't syncing`,
                      to: `/sandbox/devices`,
                      kind: `needs` as const,
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
                      kind: `needs` as const,
                  },
              ]),
        /* THE TWO NOTES, and the line they sit under is the point of `kind`.
         *
         * A contended port is not a fault: the sandbox is fine and so is the machine, one number went to
         * whichever sandbox asked for it first. Worth saying, because the symptom (a dev server missing from
         * localhost) otherwise sends people hunting a process that does not exist. Not worth a counter on the
         * chip, because on any machine running two sandboxes it is true every day, and it is the Devices row
         * that carries the number now, beside the sentence and the button that free the port.
         *
         * A new version is the same shape from the other end: nothing is wrong until you want it, and the
         * Overview card that offers the update is the whole errand. Neither of these is a debt; the difference
         * between "the agent can't run a turn" and "there is a newer image" should not be a difference the
         * reader has to click to find out. */
        ...(contendedPorts.value.length === 0
            ? []
            : [
                  {
                      icon: `desktop` as const,
                      tone: `info` as const,
                      message: `${contendedPorts.value.length} port${contendedPorts.value.length === 1 ? `` : `s`} couldn't be mirrored to your localhost`,
                      to: `/sandbox/devices`,
                      count: contendedPorts.value.length,
                      kind: `note` as const,
                  },
              ]),
        // The update note, split by whether it is already downloaded — updateItems above says why.
        ...updateItems(updateAvailable.value, updateStaged.value),
    ]);

    /* THE TWO LISTS THE SURFACES ACTUALLY RENDER. `items` stays the declaration, one place, worst-first, and
     * these are the two halves of it, so a new item is filed by writing its `kind` rather than by remembering
     * to add it to a second array. */
    const needs = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `needs`));
    const notes = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `note`));

    /* ONE chip states ONE thing (see ViewBadge): the head DEBT's shape, its count where the amount is the
     * message, its glyph otherwise, and every debt's sentence in the tooltip, which is the only place a second
     * pending item is sayable without a second badge.
     *
     * Read off `needs` first, so the chip cannot wear a number for something nobody owes; a note that earned
     * the right (`badges`, and today that is only a staged update) shows only when every debt is clear, in its
     * own quieter tone, and its tooltip carries just its own sentence — the debts' joined tooltip belongs to
     * the debts. The rest of the notes are still in the popover; they simply do not summon anyone to open it. */
    const badge = computed<ViewBadge | undefined>(() => {
        const [head] = needs.value;
        if (head !== undefined) {
            return {
                ...(head.count === undefined ? { mark: head.icon } : { count: head.count }),
                tone: head.tone,
                tooltip: needs.value.map((item) => item.message).join(` · `),
            };
        }
        const ready = notes.value.find((item) => item.badges === true);
        if (ready === undefined) {
            return undefined;
        }
        return { mark: ready.icon, tone: ready.tone, tooltip: ready.message };
    });

    // No `items`: a surface that rendered the undivided list would be the heading bug back again, so the only way
    // out of this module is by kind.
    return { needs, notes, badge };
}
