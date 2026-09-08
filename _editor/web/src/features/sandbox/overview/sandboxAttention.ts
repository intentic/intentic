import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { acpProviders } from "../../chat/accounts/providerCatalog";
import { useMissingSecretCount } from "../../capabilities/connect/useSecrets";
import { useSyncHealth } from "../devices/useDevices";
import { useEnvironment } from "../environment/useEnvironment";
import { useSandboxVersion } from "./useSandboxVersion";

// What the active sandbox needs from its owner, versus what's merely true of it: one list, split by `kind`, read
// by the rail chip and the mobile menu so they agree. Lives as a badge on the chip, not a dismissible bar, since
// none of these is urgent and each is a standing condition rather than an event.

// Whether anything can run a turn (a stored provider account, a translator subscription, or an ACP agent); silent
// until accounts have loaded, so a claim isn't retracted a moment later.
const noAccountConnected = computed(
    () =>
        accountsLoaded.value &&
        acpProviders.value.length === 0 &&
        !Object.values(providerAccounts.value).some((accounts) => accounts.length > 0) &&
        !Object.values(translatorAccounts.value).some((subscriptions) => subscriptions.length > 0),
);

export interface SandboxAttentionItem {
    // Glyph for this item's popover row, and the chip's badge when it's the top one.
    readonly icon: IconName;
    // `warning` is a debt that will bite; `info` is optional. Never `danger`: unfinished, not broken.
    readonly tone: "warning" | "info";
    // Whether this may badge the chip: a `needs` can, a `note` can't (a standing condition badging forever teaches
    // the reader to ignore it).
    readonly kind: "needs" | "note";
    // Stands alone in a popover row, and reads as a clause when the chip's tooltip joins several. No trailing period.
    readonly message: string;
    // Tab that resolves it; several items can share one.
    readonly to: string;
    // Set only when the amount is the message (e.g. how many secrets are missing).
    readonly count?: number;
    // Lets a `note` badge the chip when no `needs` does; only a staged update qualifies today, since acting on it is
    // one click.
    readonly badges?: boolean;
}

// An available update stays a quiet note (still downloading in the background); once staged it may badge the
// chip (`badges`), since applying it is now one click and a half-minute restart.
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

    // Declared worst-first: the head sets the badge, the rest fills the popover. No-account is about the sandbox as a
    // whole, not one conversation's missing provider (composer's connect gate).
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
        // Outranks secrets below since it fails silently: the card still reads "Enabled" while edits simply stop
        // syncing.
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
        // Neither is a debt: a contended port is the machine working correctly (Devices carries the count); a new
        // version is nothing wrong until wanted, and the Overview card is the whole errand.
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
        // Split by whether the update is already downloaded; see updateItems.
        ...updateItems(updateAvailable.value, updateStaged.value),
    ]);

    // The two halves surfaces actually render; filed by `kind` rather than a second array to remember.
    const needs = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `needs`));
    const notes = computed<readonly SandboxAttentionItem[]>(() => items.value.filter((item) => item.kind === `note`));

    // One chip states one thing: the head `needs` sets shape and count/glyph, with every `needs` message joined in
    // the tooltip. Falls back to a `note` that earned `badges` only once no `needs` remains.
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

    // No `items`: a surface reading the undivided list is the old heading bug again.
    return { needs, notes, badge };
}
