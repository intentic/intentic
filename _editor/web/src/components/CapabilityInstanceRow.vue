<!-- ONE CONNECTION OF THE CARD YOU ARE STANDING ON, and what you can do to it.
     A list of accounts is a LIST: <Row> at the density every other record list in the app is read at, the name
     it was given, what tells it apart, the state it is in, and its actions.

     THE ROW IS READ IN A COLUMN 32rem WIDE, which is the fact that shapes everything below. It shares the form
     pane with the card's reference column, and it used to lay its name, its address and three word-labelled
     buttons out on ONE line: at that width the address landed on top of the name, the state badge fell to a
     second line, and the buttons (the least important thing on the row) took half of it. So the row is two
     lines by design (name and state above, the address that identifies it below, both free to use the full
     width), and the right-hand side carries at most ONE button.

     THAT ONE BUTTON IS THE STEP THIS CONNECTION IS WAITING ON: connect the computer, sign the account in, or,
     once nothing is outstanding, the thing people actually come back to do (open the browser). Everything else
     lives behind the row's overflow menu, which is also where the two verbs every connection has go: rename it,
     remove it. A menu is the right home for them precisely because they are rare and identical on every row:
     five text buttons repeated down a list are five things to read past to find the one that differs.

     THE BUTTONS ARE PER KIND, and every one of them acts on THIS row's connection rather than on the card: a
     card can hold a work Reddit and a personal one, three SSH boxes, two databases. Which appear is decided
     here, in named predicates, rather than in a column of conditions down the template: the row is the only
     place that knows both the kind and the state, and those two together are the whole rule. -->
<script setup lang="ts">
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { HostSummary, WebExtSummary } from "@intentic/sandbox-contract";
import { Button, ContextMenu, CopyButton, type IconName, Row, StatusBadge, ui } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import { useMenuLink } from "../composables/menuLink";
import { type ConnectionState, rebuildStep, signsInByHand } from "../pages/capabilities/connections";

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
    /** The card's form is open over THIS row: it wears the selected tint so the fields below have a subject. */
    editing?: boolean;
}>();

const emit = defineEmits<{ connect: []; revoke: []; browse: []; login: []; agentLogin: []; edit: []; rename: []; remove: [] }>();

/* A computer is connected by running a command ON IT; a browser, by pasting a code INTO IT. Either way the
 * connection is made at the far end, so one that has never checked in is waiting on that step, and one that HAS
 * is merely asleep (a closed lid, a quit browser) — which a fresh pairing does not wake. The button says which.
 *
 * The two kinds share these predicates rather than each having their own, because everything the row does with
 * them is identical; what differs is the icon and the dialog, and the page owns the dialog. */
const isHost = computed(() => props.entry.kind === `host`);
const isBrowser = computed(() => props.entry.kind === `webext`);
const pairs = computed(() => isHost.value || isBrowser.value);
const paired = computed(() => Boolean(props.host?.lastSeen ?? props.browser?.lastSeen));

// A browser capability connects via a live login window, not a form. Once it IS signed in, the same window is
// also the way to USE the account: check a message, clear a captcha, change a setting the agent shouldn't.
const signsIn = computed(() => signsInByHand(props.entry.kind));
const connected = computed(() => props.instance.status.state === `active`);

// An ACP agent with a declared loginCommand signs in interactively: the daemon starts it in the capability's job
// session and the terminal panel opens on it.
const agentSignIn = computed(() => props.entry.kind === `agent` && props.instance.config[`loginCommand`] !== undefined);

// The DevOps capability is the ground other cards stand on; taking it away is not a row-level action.
const removable = computed(() => props.entry.kind !== `devops`);

// The one step this row cannot offer itself: a rebuild, which happens on the Sandbox screen.
const needsRebuild = computed(() => rebuildStep(props.entry.kind, props.instance));

/* THE STEP THAT HAPPENS ON A DEVICE THIS APP CANNOT REACH: a code the daemon is holding out, to be typed into
 * a phone standing next to the reader (WhatsApp's link-a-device ceremony). It gets a block of its own under the
 * row rather than a line inside it, and that is the point: a code is read off the screen and typed by hand
 * somewhere else, so it has to survive being looked away from and back at, at arm's length, and it has to be
 * copyable in one press. Squeezed into the row's description it was six characters of body text next to a
 * hostname; on a card that never refreshed, it wasn't there at all.
 *
 * The waiting sentence gets the same block for the same reason: what the reader needs to know in the seconds
 * before a code exists is that one is COMING and this screen will show it: the exact belief that being sent
 * back to the catalog with a green badge destroyed. */
const pendingStep = computed(() => (props.instance.status.state === `pending` && !needsRebuild.value ? props.instance.status.detail : undefined));
const pairingCode = computed(() => props.instance.status.code);

/* THE ONE ACTION THAT EARNS THE ROW'S ONLY BUTTON. Ordered by urgency rather than by kind: a connection that
 * cannot be used until somebody does something shows THAT, and one that works shows the way back into it.
 * Undefined is a perfectly good answer: an MCP server or a connected database has nothing to press, and an
 * empty right-hand side is what lets the name and the address have the width. */
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

const link = useMenuLink();
const menu = ref<{ show: (event: Event) => void } | undefined>();

/* WHAT IS LEFT AFTER THE PRIMARY, in one order: the kind's own secondary verbs, then the three every connection
 * has. Settings leads them, and it is the reason this menu was worth opening at all: every field this
 * connection was set up with is behind it, on the card's own form, which until now could only ADD. Changing one
 * setting meant removing the connection and building it again, which for a signed-in account or a paired
 * machine throws away the very thing that makes it worth keeping.
 *
 * Rename is next, and stays separate from it for the same reason it always did: the name is the agent's handle
 * for the thing: a skill file, an env var, an alias, a browser profile directory, so changing it is a
 * migration the daemon performs, not a field on a form. */
const items = computed<MenuItem[]>(() => {
    const kindActions: MenuItem[] = [];
    // Also the way to re-log-in once a session expires. An identity's window is the same thing pointed at its
    // email provider: the one login that stays human.
    if (signsIn.value && connected.value) {
        kindActions.push({ label: `Re-log in`, icon: `sign-in`, command: () => emit(`login`) });
    }
    // Revoke cuts this machine off without removing the capability, so the card keeps its name and permissions
    // and Connect re-pairs it. Removing the capability does both, which is a different intent.
    if (pairs.value && paired.value) {
        kindActions.push({ label: `Revoke access`, icon: `sign-out`, command: () => emit(`revoke`) });
    }
    // A VPN is dialled from the Status card, which owns the whole flow (progress, the gateway's own error text,
    // a one-time code field). Going there beats a second, thinner set of controls that would handle 2FA worse.
    if (props.entry.kind === `vpn`) {
        kindActions.push({ label: `Connect / disconnect`, icon: `wifi`, ...link(`/sandbox/status`) });
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
    <!-- One divided cell of the group: the row, and, while something is outstanding on another device, the
         step it is waiting on, directly under it. -->
    <div>
        <!-- Tinted while the form below is over THIS connection: the fields are a long way down a narrow pane,
             and without it a form pre-filled with somebody's live gateway is indistinguishable from one
             pre-filled with the card's defaults. -->
        <Row density="compact" :selected="editing">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <!-- Mono because it is an identifier, not a label: it is what the agent's skill, its tools
                         and its env vars are named after, and it is compared character by character against
                         them. -->
                    <span class="truncate font-mono">{{ instance.id }}</span>
                    <StatusBadge size="xs" :dot="true" :variant="state.tone" :label="state.label" />
                </span>
            </template>
            <!-- WHAT TELLS THIS CONNECTION APART, on its own line and with the whole width to do it in. It used
                 to sit in the row's trailing #meta cluster, capped at 10rem and pressed against the name:
                 which for the things that actually live here (an email address, a host:port, a database) is
                 exactly the wrong half of the string to keep. -->
            <template v-if="facts || needsRebuild" #description>
                <!-- `block`, because an inline span cannot be ellipsised: a tunnel that lists every network it
                     carries, or a mailbox at somebody's very long company domain, would otherwise run under the
                     row's button. The whole value is one hover away. -->
                <span v-if="facts" class="block truncate font-mono" :title="facts">{{ facts }}</span>
                <!-- Wraps where the address truncates: the tail of this one is the way out of the state it
                     describes, and an ellipsis would be hiding exactly the words that lead somewhere. -->
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

        <!-- THE CODE, AT THE SIZE IT IS ACTUALLY USED AT. Wide tracking and `select-all` because it is
             transcribed character by character into a handset: the two failure modes are misreading it and
             losing your place in it, and both are geometry. `tabular-nums` keeps it from jumping as it is
             replaced in place: WhatsApp mints a new code whenever it drops the unlinked socket, and the card
             swaps it under the reader rather than making them go and find it again. -->
        <!-- Recessed against the group's own surface (the bg-canvas-inside-bg-card pattern), so the block reads
             as a step attached to this row rather than as a second row under it. -->
        <div v-if="pendingStep" class="flex flex-col gap-2 border-t border-line-subtle bg-canvas px-3 py-2.5">
            <div v-if="pairingCode" class="flex flex-wrap items-center gap-3">
                <span class="select-all font-mono text-xl font-semibold tracking-[0.3em] text-content tabular-nums">{{ pairingCode }}</span>
                <CopyButton :text="pairingCode" label="Copy" />
            </div>
            <!-- The sentence stays whatever the daemon said: the phone's own menu path when a code is up, what
                 WhatsApp refused when it refused, and "waiting…" in between. -->
            <span class="text-xs text-warning">{{ pendingStep }}</span>
        </div>
    </div>
</template>
