<!-- One connection: its name, whether it works and what tells it apart, opening in place on its own settings. -->
<script setup lang="ts">
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { PhoneSummary } from "@intentic/sandbox-contract/schemas/phone";
import type { WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { Button, ContextMenu, CopyButton, DisclosureRow, type IconName, StatusBadge, toneDot } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { type ConnectionState, machineAway, rebuildStep, signsInByHand } from "../../../models/capabilities/connections";
import { connectedLinks } from "../../../models/capabilities/credentialGuide";
import { seedValues } from "../../../models/capabilities/form";
import { type HubRowView, saveLabel } from "../../../models/hub/connectionHub";
import { useT } from "@intentic/ui/i18n";
import { here, page } from "../../../lib/routes/links";
import { hostPresets, matchHostPreset } from "../model/previews";

const t = useT();

const props = defineProps<{
    entry: CapabilityCatalogEntry;
    instance: CapabilitySummary;
    /** The roster's answer for a host-kind connection: whether it has ever paired, and whether it is up now. */
    host?: HostSummary | undefined;
    /** The same, for a webext-kind one: the browser this extension is installed in. */
    browser?: WebExtSummary | undefined;
    /** The same, for a phone-kind one: the phone the Intentic Device app runs on. */
    phone?: PhoneSummary | undefined;
    /** The state in the reader's words: read from the same place the Connected inventory reads it. */
    state: ConnectionState;
    /** What this connection says about itself: a tunnel's address, a machine's OS, a database's host. */
    facts: string;
    /** Its settings are open under it (the page's `edit`); the default slot is what they are. */
    open?: boolean;
    /** Its place in the connections hub, for a kind that travels: the computers it can be saved to, and what it says. */
    hub?: HubRowView | undefined;
}>();

const emit = defineEmits<{
    "update:open": [open: boolean];
    connect: [];
    revoke: [];
    browse: [];
    login: [];
    agentLogin: [];
    rename: [];
    remove: [];
    save: [machine: string];
}>();

// A device connects by running a command on it; a browser, by pasting a code into it; a phone, by scanning a code
// with it. One that's never checked in is waiting on that step; one that has is merely asleep, which a fresh pairing
// won't wake.
const isHost = computed(() => props.entry.kind === `device`);
const isBrowser = computed(() => props.entry.kind === `webext`);
const isPhone = computed(() => props.entry.kind === `phone`);
const pairs = computed(() => isHost.value || isBrowser.value || isPhone.value);
// The roster's lastSeen starts over when the sandbox restarts, so a machine the daemon still holds paired (its away
// detail) counts too: its row offers Reconnect, not the first Connect.
const paired = computed(
    () => Boolean(props.host?.lastSeen ?? props.browser?.lastSeen ?? props.phone?.lastSeen) || (isHost.value && machineAway(props.instance)),
);
// Working as it should: the row then says nothing about its state but its dot, and asks nothing of the reader.
const healthy = computed(() => props.state.tone === `success`);

// A browser capability connects via a live login window; once signed in, the same window is how the user acts in it.
const signsIn = computed(() => signsInByHand(props.entry.kind));
const connected = computed(() => props.instance.status.state === `active`);

// An ACP agent with a loginCommand signs in interactively: the daemon starts it and the terminal panel opens on it.
const agentSignIn = computed(() => props.entry.kind === `agent` && props.instance.config[`loginCommand`] !== undefined);

// What the card's manifest offers to do next on the service's own site (Discord's invite), once the connection holds
// what the link is built from.
const links = computed(() => connectedLinks(props.entry, props.instance.config));

// The one step a row can't offer itself: a rebuild, done on the Sandbox screen.
const needsRebuild = computed(() => rebuildStep(props.entry.kind, props.instance));

// A code the daemon holds out to be typed elsewhere (WhatsApp's link-a-device) gets its own block, easy to find and
// copy, rather than a line inside the row. The waiting sentence shares that block, so the reader knows one is coming.
// A machine the roster knows more about than its stored status (up only through a distro) says that instead.
const pendingStep = computed(
    () => props.state.note ?? (props.instance.status.state === `pending` && !needsRebuild.value ? props.instance.status.detail : undefined),
);
const pairingCode = computed(() => props.instance.status.code);

// A computer's access in the words of the form that sets it, so the row answers "what may the agent do there" closed.
const access = computed(() => {
    if (!isHost.value) {
        return undefined;
    }
    const preset = matchHostPreset(seedValues(props.entry, props.instance.config, {}));
    return hostPresets().find((candidate) => candidate.key === preset)?.label ?? t(`capabilities.capabilityInstanceRow.customAccess`);
});

// The row's one button, only where the reader has something to do: a connection that can't be used shows the way to
// fix it; one that works shows nothing, its Reconnect moving into its open settings. A signed-in browser keeps the way
// into it, since using it is what the row is for.
const primary = computed<{ label: string; icon: IconName; run: () => void } | undefined>(() => {
    if (pairs.value) {
        if (paired.value && healthy.value) {
            return undefined;
        }
        return {
            label: paired.value ? t(`ui.action.reconnect`) : t(`ui.action.connect`),
            icon: isBrowser.value ? `globe` : isPhone.value ? `mobile` : `desktop`,
            run: () => emit(`connect`),
        };
    }
    if (signsIn.value) {
        return connected.value
            ? { label: t(`capabilities.capabilityInstanceRow.openBrowser`), icon: `globe`, run: () => emit(`browse`) }
            : { label: t(`capabilities.capabilityInstanceRow.logIn`), icon: `sign-in`, run: () => emit(`login`) };
    }
    if (agentSignIn.value) {
        return { label: t(`ui.action.signIn`), icon: `sign-in`, run: () => emit(`agentLogin`) };
    }
    return undefined;
});

// The open row's own verbs, after its settings, in place of the ⋯ menu: the kind's own first, then Rename and Remove.
interface Verb {
    readonly key: string;
    readonly label: string;
    readonly icon: IconName;
    readonly run: (event: Event) => void;
}
// Saving to one of several computers is a pick, kept in a menu under its one press.
const saveMenu = ref<{ show: (event: Event) => void } | undefined>();
const saveTo = computed(() => (props.hub?.busy === true ? [] : (props.hub?.saveTo ?? [])));
const saveItems = computed<MenuItem[]>(() => saveTo.value.map((machine) => ({ label: machine, command: () => emit(`save`, machine) })));
const verbs = computed<Verb[]>(() => {
    const kind: Verb[] = [];
    if (pairs.value && paired.value && healthy.value) {
        kind.push({ key: `reconnect`, label: t(`ui.action.reconnect`), icon: `refresh`, run: () => emit(`connect`) });
    }
    // Also how to re-log-in once a session expires; an identity's window points at its email provider instead.
    if (signsIn.value && connected.value) {
        kind.push({ key: `login`, label: t(`capabilities.capabilityInstanceRow.reLogIn`), icon: `sign-in`, run: () => emit(`login`) });
    }
    // Kept on the owner's computer for their other sandboxes: the one computer by name, or a pick when there are several.
    // A connection that cannot travel offers nothing, rather than a press the sandbox would refuse.
    const [only] = saveTo.value;
    if (only !== undefined) {
        kind.push({
            key: `save`,
            label: saveLabel(saveTo.value),
            icon: `desktop`,
            run: (event) => (saveTo.value.length === 1 ? emit(`save`, only) : saveMenu.value?.show(event)),
        });
    }
    // Revoke cuts the machine off without removing the capability (name and permissions stay, Connect re-pairs);
    // removing does both.
    if (pairs.value && paired.value) {
        kind.push({ key: `revoke`, label: t(`sandbox.words.revokeAccess`), icon: `sign-out`, run: () => emit(`revoke`) });
    }
    return [...kind, { key: `rename`, label: t(`ui.action.renameEllipsis`), icon: `pencil`, run: () => emit(`rename`) }];
});
</script>

<template>
    <div>
        <DisclosureRow body="drawer" :open="open" @update:open="emit(`update:open`, $event)">
            <!-- The state as a dot, where every list in the app puts one; its word joins the name only when it is not fine. -->
            <template #lead>
                <span :class="toneDot(state.tone, `h-1.5 w-1.5 shrink-0 rounded-full`)" role="img" :aria-label="state.label" v-tooltip.top="state.label" />
            </template>
            <template #title>
                <span class="flex min-w-0 items-center gap-2">
                    <!-- Mono: an identifier the agent's skill/tools/env vars are named after, compared character by character. -->
                    <span class="min-w-0 truncate font-mono">{{ instance.id }}</span>
                    <StatusBadge v-if="!healthy" size="xs" :variant="state.tone" :label="state.label" class="shrink-0" />
                    <!-- Where the hub keeps it, quietly: saved to a computer, waiting for a yes there, or taken from one. The
                         name keeps its room; this is the one cut short. -->
                    <span v-if="hub?.note" class="flex min-w-0 flex-1 items-center gap-1 text-2xs font-normal text-subtle">
                        <Icon v-if="hub.busy" name="spinner" spin class="shrink-0" /><span class="truncate" v-tooltip.overflow="hub.note">{{ hub.note }}</span>
                    </span>
                </span>
            </template>
            <!-- What tells this connection apart, and for a computer what the agent may do there, on its own line. -->
            <template v-if="facts || access" #description>
                <!-- `block`: an inline span can't ellipsise, so a long value would run under the row's button; the full value is one hover away. -->
                <span class="block truncate" v-tooltip.top.overflow="facts"
                    ><span class="font-mono">{{ facts }}</span><template v-if="facts && access"> · </template>{{ access }}</span
                >
            </template>
            <template v-if="links.length > 0 || primary" #control>
                <div class="flex shrink-0 items-center gap-1">
                    <a
                        v-for="link in links"
                        :key="link.url"
                        :href="link.url"
                        target="_blank"
                        rel="noreferrer"
                        class="inline-flex items-center gap-1 px-1 text-xs whitespace-nowrap text-link hover:underline"
                    >
                        {{ link.label }} <Icon name="external-link" />
                    </a>
                    <Button v-if="primary" :label="primary.label" size="small" tier="quiet" @click="primary.run()">
                        <template #icon><Icon :name="primary.icon" /></template>
                    </Button>
                </div>
            </template>

            <template #below>
                <slot />
                <!-- The row's own verbs, after the settings they would otherwise sit among: quiet, and Remove apart at the end. -->
                <div class="mt-4 flex flex-wrap items-center gap-1 border-t border-line-subtle pt-3">
                    <Button v-for="verb in verbs" :key="verb.key" :label="verb.label" size="small" tier="quiet" @click="verb.run($event)">
                        <template #icon><Icon :name="verb.icon" /></template>
                    </Button>
                    <Button class="ml-auto" :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" @click="emit(`remove`)">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                    <ContextMenu ref="saveMenu" :model="saveItems" :min-width="11" />
                </div>
            </template>
        </DisclosureRow>

        <!-- The step this connection still waits on, under it whether or not it is open: the pairing itself while one is
             under way, else what the daemon says is missing. Recessed against the group's surface so it reads as a step
             on the row, not a second row. -->
        <div v-if="$slots[`pairing`]" class="border-t border-line-subtle bg-canvas px-3 py-3">
            <slot name="pairing" />
        </div>
        <div v-else-if="pendingStep || needsRebuild" class="flex flex-col gap-2 border-t border-line-subtle bg-canvas px-3 py-2.5">
            <!-- Connection codes use selectable, fixed-width digits. -->
            <div v-if="pairingCode" class="flex flex-wrap items-center gap-3">
                <span class="select-all font-mono text-xl font-semibold tracking-[0.3em] text-content tabular-nums">{{ pairingCode }}</span>
                <CopyButton :text="pairingCode" :label="t(`ui.action.copy`)" />
            </div>
            <!-- Shows whatever the daemon actually said: the phone's menu path, a refusal, or "waiting…" in between. -->
            <span v-if="pendingStep" class="text-xs text-warning">{{ pendingStep }}</span>
            <!-- The tail is the way out of the state it describes, so it stays visible rather than clamped into the row. -->
            <RouterLink v-if="needsRebuild" :to="here(page.sandboxSettings(`environment`))" class="text-2xs text-warning hover:underline">
                {{ t(`capabilities.capabilityInstanceRow.finishSetup`, { detail: instance.status.detail ?? t(`capabilities.words.needsSandboxRebuild`) }) }}
            </RouterLink>
        </div>
    </div>
</template>
