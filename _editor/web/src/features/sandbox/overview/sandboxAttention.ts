import type { IconName } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { computed } from "vue";
import { providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { acpProviders, endpointProviders } from "../../chat/accounts/providerCatalog";
import { accessKnown, providerReady } from "../../chat/session/access";
import { useMissingSecretCount } from "../../capabilities/connect/useSecrets";
import { useRole } from "../secrets/useRole";
import { useSyncHealth } from "../devices/useDevices";
import { useEnvironment } from "../environment/useEnvironment";
import { useSandboxVersion } from "./version/useSandboxVersion";
import { useSandboxBackup } from "./backup/useSandboxBackup";
import { useUnbackedWork } from "./backup/useUnbackedWork";
import { t } from "@intentic/ui/i18n";

// What the active sandbox needs from its owner, versus what's merely true of it: one list, split by `kind`, read
// by the rail chip and the mobile menu so they agree. Lives as a badge on the chip, not a dismissible bar, since
// none of these is urgent and each is a standing condition rather than an event.

// Whether anything can run a turn: a stored provider account, a translator subscription, an ACP agent, or a ready
// endpoint — the free trial is one, and `providerReady` is what spends its allowance down to not-ready.
// Waits on `accessKnown`, not the account half alone: that half lands first, and on its own this told a reader
// with a working trial that the agent could not run at all, which is the same beat access.ts already names for
// the chat's own gate.
const noAccountConnected = computed(
    () =>
        accessKnown.value &&
        acpProviders.value.length === 0 &&
        !endpointProviders.value.some((endpoint) => providerReady(endpoint.id)) &&
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
                message: t(`sandbox.sandboxAttention.sandboxUpdateReadyTo`),
                to: `/sandbox`,
                kind: `note`,
                badges: true,
            },
        ];
    }
    return [
        { icon: `arrow-circle-up`, tone: `info`, message: t(`sandbox.sandboxAttention.newSandboxVersionAvailable`), to: `/sandbox`, kind: `note` },
    ];
};

export function useSandboxAttention() {
    const { isDesk } = useRole();
    const { pending, proposal } = useEnvironment();
    const { updateAvailable, updateStaged } = useSandboxVersion();
    const { missingRequiredCount } = useMissingSecretCount();
    const { stoppedOn, heldPorts } = useSyncHealth();
    // The two ways this sandbox's work can exist in exactly one place: no copy on a computer of the owner's, and no
    // repository it could be pushed to. Both are standing conditions with a tab that resolves them, which is what
    // makes them rows here rather than events.
    const { unbacked: noCopyOffBox } = useSandboxBackup();
    const { unbacked: noRepoRemote } = useUnbackedWork();

    // Declared worst-first: the head sets the badge, the rest fills the popover. A row is its condition and its
    // item side by side rather than a spread ternary, so adding one is a line and reading the order is a column.
    // No-account is about the sandbox as a whole, not one conversation's missing provider (composer's connect gate).
    const items = computed<readonly SandboxAttentionItem[]>(() => {
        // Nothing here is a desk's errand: every row resolves on a hub tab the daemon refuses it, and a badge over a
        // door that will not open is a debt it can never pay down.
        if (isDesk.value) {
            return [];
        }
        const rows: { when: boolean; item: SandboxAttentionItem }[] = [
            {
                when: noAccountConnected.value,
                item: {
                    icon: `sparkles`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.noAiAccountConnected`),
                    to: `/sandbox/agent`,
                    kind: `needs`,
                },
            },
            {
                when: pending.value !== undefined,
                item: {
                    icon: `exclamation-triangle`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.rebuildNeededToFinish`),
                    to: `/sandbox/environment`,
                    kind: `needs`,
                },
            },
            {
                when: proposal.value !== undefined,
                item: {
                    icon: `exclamation-triangle`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.agentProposedChangeTo`),
                    to: `/sandbox/environment`,
                    kind: `needs`,
                },
            },
            // Outranks secrets below since it fails silently: the card still reads "Enabled" while edits simply stop
            // syncing.
            {
                when: stoppedOn.value.length > 0,
                item: {
                    icon: `desktop`,
                    tone: `warning`,
                    message: `Desktop sync stopped on ${stoppedOn.value.join(`, `)}, its folder isn't syncing`,
                    to: `/sandbox/devices`,
                    kind: `needs`,
                },
            },
            {
                when: missingRequiredCount.value > 0,
                item: {
                    icon: `key`,
                    tone: `warning`,
                    message: `${missingRequiredCount.value} required secret${missingRequiredCount.value === 1 ? `` : `s`} missing`,
                    to: `/sandbox/secrets`,
                    count: missingRequiredCount.value,
                    kind: `needs`,
                },
            },
            // Work that exists in one place only. Both are `needs`: nothing is broken, but each is a debt that bites
            // exactly once and takes everything with it. The copy comes before the remote — turning sync on is a
            // toggle, connecting a repository is a decision — and both stay listed until the condition is untrue.
            {
                when: noCopyOffBox.value,
                item: {
                    icon: `desktop`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.filesOnlyOnCloudMachine`),
                    to: `/sandbox/devices`,
                    kind: `needs`,
                },
            },
            {
                when: noRepoRemote.value,
                item: {
                    icon: `code`,
                    tone: `warning`,
                    message: t(`sandbox.sandboxAttention.noRepositoryToPushTo`),
                    to: `/sandbox/environment`,
                    kind: `needs`,
                },
            },
            // Neither is a debt: a port one of your own sandboxes took has a remedy on Devices whenever you want it; a
            // new version is nothing wrong until wanted, and the Overview card is the whole errand.
            // THIS USED TO COUNT EVERY PORT THAT MISSED LOCALHOST, which made a standing, correct outcome — a database
            // already running on that number here — a note and a badge that never went away. Only the ports another
            // paired sandbox took are counted now (`heldPorts`), which is the one case something can be done about.
            {
                when: heldPorts.value.length > 0,
                item: {
                    icon: `desktop`,
                    tone: `info`,
                    message: `${heldPorts.value.length} port${heldPorts.value.length === 1 ? `` : `s`} taken by another sandbox on your machine`,
                    to: `/sandbox/devices`,
                    count: heldPorts.value.length,
                    kind: `note`,
                },
            },
        ];
        return (
            rows
                .filter((row) => row.when)
                .map((row) => row.item)
                // Split by whether the update is already downloaded; see updateItems.
                .concat(updateItems(updateAvailable.value, updateStaged.value))
        );
    });

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
