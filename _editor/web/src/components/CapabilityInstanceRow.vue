<!-- ONE CONNECTION OF THE CARD YOU ARE STANDING ON, and what you can do to it.
     A list of accounts is a LIST: <Row> at the density every other record list in the app is read at, one line
     each. It used to be a stack of two-line blocks whose second line was a strip of icon-only effect glyphs
     repeated identically under every row — the same three symbols under all three GitHub connections, saying
     nothing that distinguished one from another, and clickable-looking without being clickable. Effects are a
     fact about the CARD, so they are stated once beside the form. What is left is what actually differs per
     connection: its name, its state, the live fact it reports, and what you can do to it.

     THE BUTTONS ARE PER KIND, and every one of them acts on THIS row's connection rather than on the card: a
     card can hold a work Reddit and a personal one, three SSH boxes, two databases. Which appear is decided
     here, in named predicates, rather than in a column of conditions down the template — the row is the only
     place that knows both the kind and the state, and those two together are the whole rule. -->
<script setup lang="ts">
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import type { HostSummary } from "@intentic/sandbox-contract";
import { Row, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed } from "vue";
import { type ConnectionState, rebuildStep, signsInByHand } from "../pages/capabilities/connections";

const props = defineProps<{
    entry: CapabilityCatalogEntry;
    instance: CapabilitySummary;
    /** The roster's answer for a host-kind connection: whether it has ever paired, and whether it is up now. */
    host?: HostSummary | undefined;
    /** The state in the reader's words — read from the same place the Connected inventory reads it. */
    state: ConnectionState;
    /** What this connection says about itself: a tunnel's address, a machine's OS, a database's host. */
    facts: string;
}>();

const emit = defineEmits<{ connect: []; revoke: []; browse: []; login: []; agentLogin: []; remove: [] }>();

// A computer is connected by running a command ON IT. One that has never checked in is waiting on that
// one-liner; one that HAS is merely asleep, and a fresh pairing is not what wakes it — so the button says which.
const isHost = computed(() => props.entry.kind === `host`);
const paired = computed(() => Boolean(props.host?.lastSeen));

// A browser capability connects via a live login window, not a form. Once it IS signed in, the same window is
// also the way to USE the account: check a message, clear a captcha, change a setting the agent shouldn't.
const signsIn = computed(() => signsInByHand(props.entry.kind));
const connected = computed(() => props.instance.status.state === `active`);

// An ACP agent with a declared loginCommand signs in interactively: the daemon starts it in the capability's job
// session and the terminal panel opens on it.
const agentSignIn = computed(() => props.entry.kind === `agent` && props.instance.config[`loginCommand`] !== undefined);

// The DevOps capability is the ground other cards stand on; taking it away is not a row-level action.
const removable = computed(() => props.entry.kind !== `devops`);

// The one step this row cannot offer itself — a rebuild, which happens on the Sandbox screen.
const needsRebuild = computed(() => rebuildStep(props.entry.kind, props.instance));
</script>

<template>
    <Row density="compact">
        <template #title>
            <span class="flex flex-wrap items-center gap-2">
                <span class="font-mono">{{ instance.id }}</span>
                <StatusBadge size="xs" :dot="true" :variant="state.tone" :label="state.label" />
                <!-- The unfinished step, in line with the badge that named it: it is one clause, and giving it a
                     line of its own is what made these rows two-deep. The badge says the STATE in the reader's
                     words and this says what is actually outstanding, in the daemon's — the same division
                     <CapabilityConnections> draws between a row's state and its note. -->
                <RouterLink v-if="needsRebuild" to="/sandbox/environment" class="text-2xs text-warning hover:underline">
                    {{ instance.status.detail ?? "Needs a sandbox rebuild" }} — Finish setup →
                </RouterLink>
            </span>
        </template>
        <!-- CAPPED, because a split tunnel lists every network it carries and the column does not shrink — left
             to run, it pushed the name and its badge onto two lines. The full list is one hover away and,
             unabridged, on the Status card that dials the thing. -->
        <template v-if="facts" #meta>
            <span class="block max-w-40 truncate font-mono" :title="facts">{{ facts }}</span>
        </template>
        <template #control>
            <div class="flex items-center gap-1">
                <Button v-if="isHost" :label="paired ? 'Reconnect' : 'Connect'" size="small" :text="true" @click="emit(`connect`)">
                    <template #icon><Icon name="desktop" /></template>
                </Button>
                <!-- Revoke cuts this machine off without removing the capability, so the card keeps its name and
                     permissions and Connect re-pairs it. Removing the capability does both, which is a different
                     intent. -->
                <Button v-if="isHost && paired" label="Revoke" size="small" :text="true" severity="warn" @click="emit(`revoke`)">
                    <template #icon><Icon name="sign-out" /></template>
                </Button>
                <Button v-if="signsIn && connected" label="Open browser" size="small" :text="true" @click="emit(`browse`)">
                    <template #icon><Icon name="globe" /></template>
                </Button>
                <!-- Also the way to re-log-in once a session expires. An identity's window is the same thing
                     pointed at its email provider — the one login that stays human. -->
                <Button v-if="signsIn" :label="connected ? 'Re-log in' : 'Log in'" size="small" :text="true" @click="emit(`login`)">
                    <template #icon><Icon name="sign-in" /></template>
                </Button>
                <Button v-if="agentSignIn" label="Sign in" size="small" :text="true" @click="emit(`agentLogin`)">
                    <template #icon><Icon name="sign-in" /></template>
                </Button>
                <!-- A VPN is dialled from the Status card, which owns the whole flow (progress, the gateway's own
                     error text, a one-time code field). Linking there beats a second, thinner set of controls
                     that would handle 2FA worse. -->
                <RouterLink
                    v-if="entry.kind === 'vpn'"
                    to="/sandbox/status"
                    class="inline-flex items-center gap-1 px-2 text-2xs text-link hover:underline"
                >
                    Connect / disconnect <Icon name="arrow-right" class="text-2xs" />
                </RouterLink>
                <Button
                    v-if="removable"
                    size="small"
                    severity="danger"
                    :text="true"
                    :rounded="true"
                    aria-label="Remove instance"
                    @click="emit(`remove`)"
                >
                    <template #icon><Icon name="trash" /></template>
                </Button>
            </div>
        </template>
    </Row>
</template>
