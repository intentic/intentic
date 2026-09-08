<!--
    One connection's row: name and state on the first line, its address on the second, at most one primary action — whichever step this connection
    needs next. Rename and remove live behind the overflow menu; which primary action shows is decided per kind and state, in this file.
-->
<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { HostSummary, WebExtSummary } from "@intentic/sandbox-contract";
import { Button, ContextMenu, CopyButton, type IconName, Row, StatusBadge, ui } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { type ConnectionState, rebuildStep, signsInByHand } from "../model/connections";

const props = defineProps<{
    entry: CapabilityCatalogEntry;
    instance: CapabilitySummary;
    /** The roster's answer for a host-kind connection: whether it has ever paired, and whether it is up now. */
    host?: HostSummary | undefined;
    /** The same, for a webext-kind one: the browser this extension is installed in. */
    browser?: WebExtSummary | undefined;
    /** The state in the reader's words: read from the same place the Connected inventory reads it. */
    state: ConnectionState;
    /** What this connection says about itself: a tunnel's address, a machine's OS, a database's host. */
    facts: string;
    /** The card's form is open over this row; it wears the selected tint so the fields below have a subject. */
    editing?: boolean;
}>();

const emit = defineEmits<{ connect: []; revoke: []; browse: []; login: []; agentLogin: []; edit: []; rename: []; remove: [] }>();

// A device connects by running a command on it; a browser, by pasting a code into it. One that's never checked in
// is waiting on that step; one that has is merely asleep, which a fresh pairing won't wake.
const isHost = computed(() => props.entry.kind === `host`);
const isBrowser = computed(() => props.entry.kind === `webext`);
const pairs = computed(() => isHost.value || isBrowser.value);
const paired = computed(() => Boolean(props.host?.lastSeen ?? props.browser?.lastSeen));

// A browser capability connects via a live login window; once signed in, the same window is how the user acts in it.
const signsIn = computed(() => signsInByHand(props.entry.kind));
const connected = computed(() => props.instance.status.state === `active`);

// An ACP agent with a loginCommand signs in interactively: the daemon starts it and the terminal panel opens on it.
const agentSignIn = computed(() => props.entry.kind === `agent` && props.instance.config[`loginCommand`] !== undefined);

// DevOps is the ground other cards stand on; removing it isn't a row-level action.
const removable = computed(() => props.entry.kind !== `devops`);

// The one step a row can't offer itself: a rebuild, done on the Sandbox screen.
const needsRebuild = computed(() => rebuildStep(props.entry.kind, props.instance));

// A code the daemon holds out to be typed elsewhere (WhatsApp's link-a-device) gets its own block, easy to find and
// copy, rather than a line inside the row. The waiting sentence shares that block, so the reader knows one is coming.
const pendingStep = computed(() => (props.instance.status.state === `pending` && !needsRebuild.value ? props.instance.status.detail : undefined));
const pairingCode = computed(() => props.instance.status.code);

// The row's one button, ordered by urgency: a connection that can't be used shows what to do, one that works shows
// the way back in. Undefined is fine, e.g. an MCP server has nothing to press.
const primary = computed<{ label: string; icon: IconName; run: () => void } | undefined>(() => {
    if (pairs.value) {
        return { label: paired.value ? `Reconnect` : `Connect`, icon: isBrowser.value ? `globe` : `desktop`, run: () => emit(`connect`) };
    }
    if (signsIn.value) {
        return connected.value
            ? { label: `Open browser`, icon: `globe`, run: () => emit(`browse`) }
            : { label: `Log in`, icon: `sign-in`, run: () => emit(`login`) };
    }
    if (agentSignIn.value) {
        return { label: `Sign in`, icon: `sign-in`, run: () => emit(`agentLogin`) };
    }
    return undefined;
});

const menu = ref<{ show: (event: Event) => void } | undefined>();

// After the primary action: the kind's own verbs, then Settings, Rename, Remove. Settings opens the same form that
// could previously only add; Rename is separate since renaming is a daemon migration, not a form field.
const items = computed<MenuItem[]>(() => {
    const kindActions: MenuItem[] = [];
    // Also how to re-log-in once a session expires; an identity's window points at its email provider instead.
    if (signsIn.value && connected.value) {
        kindActions.push({ label: `Re-log in`, icon: `sign-in`, command: () => emit(`login`) });
    }
    // Revoke cuts the machine off without removing the capability (name and permissions stay, Connect re-pairs);
    // removing does both.
    if (pairs.value && paired.value) {
        kindActions.push({ label: `Revoke access`, icon: `sign-out`, command: () => emit(`revoke`) });
    }
    return [
        ...kindActions,
        ...(kindActions.length > 0 ? [{ separator: true }] : []),
        { label: `Settings…`, icon: `cog`, command: () => emit(`edit`) },
        { label: `Rename…`, icon: `pencil`, command: () => emit(`rename`) },
        ...(removable.value ? [{ label: `Remove`, icon: `trash`, danger: true, command: () => emit(`remove`) }] : []),
    ];
});
</script>

<template>
    <!-- One divided cell: the row, and, while something's outstanding, the step it's waiting on beneath it. -->
    <div>
        <!--
            Tinted while the form below is over this connection, so a pre-filled live gateway isn't mistaken for the
            card's
            defaults.
        -->
        <Row :selected="editing">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <!--
                        Mono: an identifier the agent's skill/tools/env vars are named after, compared character by
                        character.
                    -->
                    <span class="truncate font-mono">{{ instance.id }}</span>
                    <StatusBadge size="xs" :dot="true" :variant="state.tone" :label="state.label" />
                </span>
            </template>
            <!--
                What tells this connection apart, given its own line and the full width rather than a capped trailing
                cluster.
            -->
            <template v-if="facts || needsRebuild" #description>
                <!--
                    `block`: an inline span can't ellipsise, so a long value would run under the row's button; the full
                    value is one
                    hover away.
                -->
                <span v-if="facts" class="block truncate font-mono" :title="facts">{{ facts }}</span>
                <!--
                    Wraps where the address truncates: the tail is the way out of the state it describes, so it must
                    stay visible.
                -->
                <RouterLink v-if="needsRebuild" to="/sandbox/environment" class="block text-warning hover:underline">
                    {{ instance.status.detail ?? "Needs a sandbox rebuild" }}: Finish setup →
                </RouterLink>
            </template>
            <template #control>
                <div class="flex shrink-0 items-center gap-1">
                    <Button v-if="primary" :label="primary.label" size="small" :text="true" @click="primary.run()">
                        <template #icon><Icon :name="primary.icon" /></template>
                    </Button>
                    <button type="button" :class="ui.iconButton()" aria-label="More actions" @click="menu?.show($event)">
                        <Icon name="ellipsis" />
                    </button>
                    <ContextMenu ref="menu" :model="items" :min-width="11" />
                </div>
            </template>
        </Row>

        <!--
            Wide tracking and `select-all` since the code is transcribed by hand into a handset; `tabular-nums` keeps
            digits
            from jumping when WhatsApp mints a fresh code.
        -->
        <!-- Recessed against the group's surface so this reads as a step on the row, not a second row. -->
        <div v-if="pendingStep" class="flex flex-col gap-2 border-t border-line-subtle bg-canvas px-3 py-2.5">
            <div v-if="pairingCode" class="flex flex-wrap items-center gap-3">
                <span class="select-all font-mono text-xl font-semibold tracking-[0.3em] text-content tabular-nums">{{ pairingCode }}</span>
                <CopyButton :text="pairingCode" label="Copy" />
            </div>
            <!-- Shows whatever the daemon actually said: the phone's menu path, a refusal, or "waiting…" in between. -->
            <span class="text-xs text-warning">{{ pendingStep }}</span>
        </div>
    </div>
</template>
