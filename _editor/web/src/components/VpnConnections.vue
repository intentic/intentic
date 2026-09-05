<script setup lang="ts">
import type { CapabilitySummary } from "@intentic-app/api-contract";
import { Button, ContextMenu, Notice, type NoticeModel, Row, RowGroup, StatusBadge, type StatusVariant, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import type { VpnLink } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { computed, reactive, ref } from "vue";
import { useVpn } from "../composables/sandbox/useVpn";

/* THE VPN CARD'S CONNECTIONS LIST: what each configured tunnel is carrying right now, and the connect /
 * disconnect controls for it. This is the answer to "is the sandbox on the VPN, and which one": the assigned
 * address and the routed networks, not just a green dot, because "connected" alone doesn't tell you whether
 * your internal host is actually reachable through it.
 *
 * IT STANDS IN FOR <CapabilityInstanceRow> ON THE VPN CARD, which is why it carries the same overflow menu the
 * generic row does. Dialling a tunnel is not a button: it streams the client's own progress, it can come back
 * asking for a one-time code, and it fails with text (a certificate digest to pin) that has to survive being
 * read character by character. A second, thinner set of controls on the generic row would handle all three
 * worse, and two lists of the same tunnels on one card is what this replaces: the tunnel is configured here,
 * so it is dialled here, rather than sending the reader to another tab and back.
 *
 * ONE ROW PER CONFIGURED CAPABILITY, with the live link JOINED IN, and the direction matters. The rows cannot
 * come from /vpn, because that read is a second request that lands after the page and can fail on its own: a
 * list built from it shows nothing at all for the beat before it answers, and shows nothing at all, forever,
 * on the sandbox whose daemon is the reason you came here to remove the tunnel. So the capability list (which
 * the page already holds) decides which rows exist and what they are called, and the link decides what each
 * one is DOING. Where there is no link yet the row still renames and removes; it just has nothing live to say.
 *
 * The agent drives the very same daemon routes through its `vpn` command, so a tunnel it dialled appears here
 * without anything having to synchronise the two. */

const props = defineProps<{
    /** The vpn-kind capabilities on this card: what exists, and what each one is called. */
    instances: readonly CapabilitySummary[];
    /** The tunnel the card's form is open over: it wears the selected tint, exactly as the generic row does. */
    editingId?: string | undefined;
}>();

const emit = defineEmits<{ edit: [id: string]; rename: [id: string]; remove: [id: string] }>();

const { links, connect, disconnect, error: listError } = useVpn();
// The list query reports a bare message; this card knows the user came to see their VPN links.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read what your tunnels are doing.`, detail: listError.value },
);

// Per-tunnel local UI state: the in-flight action, the last streamed line, and any error, keyed by id so one
// failing tunnel never blanks another's row.
const busy = reactive(new Set<string>());
const progress = reactive<Record<string, string>>({});
const failures = reactive<Record<string, string>>({});
// The tunnel whose one-time-code field is open, and its current value. A code is never stored: it goes
// straight into the dial and is cleared afterwards.
const otpFor = ref<string>();
const otp = ref(``);

const variantOf = (state: VpnLink[`state`]): StatusVariant =>
    state === `connected` ? `success` : state === `failed` ? `danger` : state === `connecting` ? `warning` : `neutral`;

const PROVIDER_LABEL: Record<VpnLink["provider"], string> = {
    wireguard: `WireGuard`,
    fortinet: `FortiGate SSL-VPN`,
    ipsec: `IPsec`,
};

/* "14m" / "3h 20m" / "2d 4h", HOW LONG THIS TUNNEL HAS BEEN UP, read at a glance. A duration, not an age: it
 * carries two units so the answer is precise at every scale, and no "ago", because the number describes a span
 * the tunnel has been holding rather than a moment that has passed. Named for what it measures: it was `ago`,
 * which is the kit's `timeAgo` vocabulary for a different question, and the collision invited exactly the
 * substitution that would be wrong here. */
const uptime = (since: number | undefined): string | undefined => {
    if (since === undefined) {
        return undefined;
    }
    const minutes = Math.max(0, Math.round((Date.now() - since) / 60000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

// The facts that answer "what does this tunnel actually carry": full-tunnel is called out by name, because
// "0.0.0.0/0" is the single most consequential thing a connected VPN can be doing to the sandbox.
const liveFacts = (link: VpnLink): (string | undefined)[] => [
    link.address,
    link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.length > 0 ? link.routes.join(`, `) : undefined,
    link.interface,
    uptime(link.since),
];

// What the stored config can answer on its own, for the row that has no link yet: which client it dials and
// where. Read defensively because config is an open record of primitives, not a typed VPN config.
const text = (instance: CapabilitySummary, key: string): string | undefined => {
    const value = instance.config[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};

interface DialRow {
    readonly id: string;
    /** ONE LINE, and the order is the point: see `factsOfRow` below. */
    readonly facts: string;
    /** The one thing worth a second line under this row, when there is one. */
    readonly note: `rebuild` | `auto` | undefined;
    /** Undefined until /vpn answers for this one: the row exists, its live half does not yet. */
    readonly link: VpnLink | undefined;
}

/* A SECOND LINE IS EARNED, not owed. The rebuild is an errand (the client isn't installed, and nothing on this
 * card can fix it), so it is said whenever it is true. Auto-connect is a promise about the NEXT restart, which
 * is worth reading under a tunnel that is resting and is noise under one that is already up: "connects
 * automatically after a sandbox restart" beneath a green `connected` badge answers a question nobody standing
 * there has. */
const noteOf = (link: VpnLink | undefined): DialRow[`note`] => {
    if (link === undefined) {
        return undefined;
    }
    if (link.state === `unavailable`) {
        return `rebuild`;
    }
    return link.autoConnect && link.state !== `connected` && link.state !== `connecting` ? `auto` : undefined;
};

/* WHAT TELLS THIS TUNNEL APART, in ONE truncated line, which is <CapabilityInstanceRow>'s rule and it is not a
 * style preference: this list is read in the card's form column, ~32rem, and the first draft of it laid the
 * name, the provider, the gateway and four live facts out as if it still had the full-width tab it came from.
 * At the real width "FortiGate SSL-VPN" broke across two lines mid-hyphen and the address ran to three. So:
 * one line, ellipsised, whole value one hover away.
 *
 * THE LIVE FACTS LEAD, and the stored ones follow, so a connected tunnel opens with the address it was given
 * (the single most useful answer to "am I actually on the VPN") and a resting one opens with what it dials,
 * which is all there is to say about it. Both tails are what the ellipsis is allowed to eat. */
const factsOfRow = (instance: CapabilitySummary, link: VpnLink | undefined): string => {
    const provider = link?.provider ?? text(instance, `provider`);
    return [
        ...(link === undefined ? [] : liveFacts(link)),
        provider !== undefined && provider in PROVIDER_LABEL ? PROVIDER_LABEL[provider as VpnLink[`provider`]] : provider,
        link?.gateway ?? text(instance, `gateway`),
    ]
        .filter((fact): fact is string => fact !== undefined && fact !== ``)
        .join(` · `);
};

const rows = computed<DialRow[]>(() =>
    props.instances.map((instance) => {
        const link = links.value.find((candidate) => candidate.id === instance.id);
        return { id: instance.id, facts: factsOfRow(instance, link), note: noteOf(link), link };
    }),
);

const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    busy.add(id);
    delete failures[id];
    try {
        await action();
    } catch (caught) {
        failures[id] = errorMessage(caught, `The VPN action failed.`);
    } finally {
        busy.delete(id);
        delete progress[id];
    }
};

const onConnect = async (id: string): Promise<void> => {
    const code = otpFor.value === id ? otp.value.trim() : ``;
    await run(id, () =>
        connect(id, code === `` ? undefined : code, (message) => {
            progress[id] = message;
        }),
    );
    otpFor.value = undefined;
    otp.value = ``;
};

const onDisconnect = (id: string): Promise<void> => run(id, () => disconnect(id));

// A gateway that wants a token says so in the failure: offer the code field right where the user just failed
// rather than making them guess that a retry needs one.
const wantsCode = (id: string): boolean => /one-time code|2FA|token/i.test(failures[id] ?? ``);

/* The three verbs every connection on this page has, in the same order and behind the same glyph as
 * <CapabilityInstanceRow>'s menu: they are rare and identical on every row, so putting them behind the
 * ellipsis is what leaves the row's right-hand side to the one control that differs, the dial.
 *
 * ONE MENU FOR THE WHOLE LIST, opened over whichever row was pressed. A <ContextMenu> per row would mount a
 * teleported overlay per tunnel for a thing that is only ever open over one of them. */
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuFor = ref<string>();
const openMenu = (id: string, event: Event): void => {
    menuFor.value = id;
    menu.value?.show(event);
};
const items = computed<MenuItem[]>(() => {
    const id = menuFor.value ?? ``;
    return [
        { label: `Settings…`, icon: `cog`, command: () => emit(`edit`, id) },
        { label: `Rename…`, icon: `pencil`, command: () => emit(`rename`, id) },
        { label: `Remove`, icon: `trash`, danger: true, command: () => emit(`remove`, id) },
    ];
});

/* The consequence worth stating once, beside the group's NAME rather than as a last child of the list: while a
 * tunnel is up, everything the sandbox does (agent turns, git, package installs) leaves through it. It used
 * to sit under the rows, where RowGroup's `divide-y` gave a paragraph a row's hairline and it read as a
 * half-drawn fourth row. */
const caption = computed(() =>
    links.value.some((link) => link.state === `connected`)
        ? `traffic matching a connected tunnel's routes leaves the sandbox through it: including the agent's`
        : undefined,
);
</script>

<template>
    <RowGroup label="Your connections" :count="rows.length" :caption="caption">
        <!-- The tunnels are still listed under it: this says the LIVE half is missing, not the connections. -->
        <Notice v-if="listNotice" :of="listNotice" class="m-4" />
        <Row v-for="row in rows" :key="row.id" :icon="row.link?.state === 'connected' ? 'shield' : 'globe'" :selected="editingId === row.id">
            <!-- The state rides the NAME, where every other list in the app puts it, rather than the control
                 cluster: a badge on the right is a third thing competing with the dial and the menu for the
                 half of the row that has the least space, and it is not a control. -->
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <span class="truncate">{{ row.id }}</span>
                    <StatusBadge
                        v-if="row.link"
                        size="xs"
                        dot
                        :variant="variantOf(row.link.state)"
                        :label="row.link.state"
                        v-tooltip.top="row.link.detail"
                    />
                </span>
            </template>
            <template #description>
                <!-- `block` + `truncate`: an inline span cannot be ellipsised, and a tunnel that carries three
                     networks would otherwise wrap under the row's button. The whole value is one hover away. -->
                <span v-if="row.facts" class="block truncate font-mono" :title="row.facts">{{ row.facts }}</span>
                <!-- Wraps where the facts truncate: the tail of this one is the way out of the state it
                     describes, and an ellipsis would be hiding exactly the words that lead somewhere. -->
                <span v-if="row.note === 'rebuild'" class="block text-warning">
                    Needs a sandbox rebuild to install its client:
                    <RouterLink to="/sandbox/environment" class="text-link hover:underline">finish setup →</RouterLink>
                </span>
                <span v-else-if="row.note === 'auto'" class="block">Connects automatically after a sandbox restart.</span>
            </template>
            <template #control>
                <!-- ONE button and the menu, the width this column affords. Nothing live to draw until the
                     tunnel's own state arrives: a dial rendered from the stored config alone would be guessing
                     which of Connect and Disconnect this row needs, and the wrong one drops somebody's tunnel. -->
                <div class="flex shrink-0 items-center gap-1">
                    <Button
                        v-if="row.link?.state === 'connected' || row.link?.state === 'connecting'"
                        label="Disconnect"
                        size="small"
                        :text="true"
                        :loading="busy.has(row.id)"
                        @click="onDisconnect(row.id)"
                    />
                    <Button
                        v-else-if="row.link"
                        label="Connect"
                        size="small"
                        :text="true"
                        :disabled="row.link.state === 'unavailable'"
                        :loading="busy.has(row.id)"
                        @click="onConnect(row.id)"
                    />
                    <button type="button" :class="ui.iconButton()" aria-label="More actions" @click="openMenu(row.id, $event)">
                        <Icon name="ellipsis" />
                    </button>
                </div>
            </template>
            <template v-if="progress[row.id] || failures[row.id] || otpFor === row.id" #below>
                <div class="mt-2 flex flex-col gap-2">
                    <p v-if="progress[row.id]" class="font-mono text-2xs text-subtle">{{ progress[row.id] }}</p>
                    <!-- The client's own words: a rejected password, or the exact --servercert digest to pin.
                         Preserved verbatim and wrapped, because that digest is unusable if it's truncated. -->
                    <pre
                        v-if="failures[row.id]"
                        class="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger"
                        >{{ failures[row.id] }}</pre>
                    <div v-if="otpFor === row.id" class="flex items-center gap-2">
                        <!-- `keydown.enter.prevent`, and both halves matter: this list stands INSIDE the card's
                             own form, so a bare Enter here is a form submission, and the code the reader is
                             racing a 30-second window to type would add a second VPN instead of dialling this
                             one. Preventing on keyup would be a frame too late. -->
                        <input
                            v-model="otp"
                            :class="ui.input('w-32 font-mono')"
                            placeholder="123456"
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            @keydown.enter.prevent="onConnect(row.id)"
                        />
                        <Button label="Connect with code" size="small" :loading="busy.has(row.id)" @click="onConnect(row.id)" />
                        <Button label="Cancel" size="small" severity="secondary" :text="true" @click="otpFor = undefined" />
                    </div>
                    <button
                        v-else-if="wantsCode(row.id)"
                        type="button"
                        :class="ui.linkButton(`gap-1 text-2xs`)"
                        @click="
                            otpFor = row.id;
                            otp = ``;
                        "
                    >
                        <Icon name="key" /> Enter a one-time code
                    </button>
                </div>
            </template>
        </Row>
        <ContextMenu ref="menu" :model="items" :min-width="11" />
    </RowGroup>
</template>
