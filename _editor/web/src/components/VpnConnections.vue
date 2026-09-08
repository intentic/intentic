<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/api-contract";
import { Button, ContextMenu, Notice, type NoticeModel, Row, RowGroup, StatusBadge, type StatusVariant, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import type { VpnLink } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { computed, reactive, ref } from "vue";
import { useVpn } from "../features/sandbox/devices/useVpn";

// Per-tunnel connections list: address, routes and connect/disconnect controls, not just a status dot. Rows
// come from the capability list, not /vpn, which can lag or fail on its own, so a row exists before any live
// link arrives. Shares CapabilityInstanceRow's overflow menu; dialing streams progress and can prompt for a code.

const props = defineProps<{
    /** The vpn-kind capabilities on this card: what exists, and what each is called. */
    instances: readonly CapabilitySummary[];
    /** The tunnel the card's form is open over; wears the selected tint, as the generic row does. */
    editingId?: string | undefined;
}>();

const emit = defineEmits<{ edit: [id: string]; rename: [id: string]; remove: [id: string] }>();

const { links, connect, disconnect, error: listError } = useVpn();
// The list query reports a bare message; this card knows the user came to see their VPN links.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read what your tunnels are doing.`, detail: listError.value },
);

// Per-tunnel local state, keyed by id, so one failing tunnel never blanks another's row.
const busy = reactive(new Set<string>());
const progress = reactive<Record<string, string>>({});
const failures = reactive<Record<string, string>>({});
// Which tunnel's code field is open, and its value; never stored, it goes straight into the dial.
const otpFor = ref<string>();
const otp = ref(``);

const variantOf = (state: VpnLink[`state`]): StatusVariant =>
    state === `connected` ? `success` : state === `failed` ? `danger` : state === `connecting` ? `warning` : `neutral`;

const PROVIDER_LABEL: Record<VpnLink["provider"], string> = {
    wireguard: `WireGuard`,
    fortinet: `FortiGate SSL-VPN`,
    ipsec: `IPsec`,
};

// "14m" / "3h 20m" / "2d 4h": a duration, not an age, so no "ago" and two units stay precise at every scale.
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

// What this tunnel actually carries; full-tunnel is called out by name since 0.0.0.0/0 is the most
// consequential thing a VPN can do here.
const liveFacts = (link: VpnLink): (string | undefined)[] => [
    link.address,
    link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.length > 0 ? link.routes.join(`, `) : undefined,
    link.interface,
    uptime(link.since),
];

// What the stored config alone can answer, for a row with no link yet. Read defensively: config is an open
// record, not a typed VPN config.
const text = (instance: CapabilitySummary, key: string): string | undefined => {
    const value = instance.config[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};

interface DialRow {
    readonly id: string;
    /** ONE LINE, and the order is the point: see factsOfRow below. */
    readonly facts: string;
    /** The one thing worth a second line under this row, when there is one. */
    readonly note: `rebuild` | `auto` | undefined;
    /** Undefined until /vpn answers for this one: the row exists, its live half does not yet. */
    readonly link: VpnLink | undefined;
}

// A second line is earned: rebuild is said whenever true (an errand nothing here can fix); auto-connect only
// when resting, since it's noise under a connected badge.
const noteOf = (link: VpnLink | undefined): DialRow[`note`] => {
    if (link === undefined) {
        return undefined;
    }
    if (link.state === `unavailable`) {
        return `rebuild`;
    }
    return link.autoConnect && link.state !== `connected` && link.state !== `connecting` ? `auto` : undefined;
};

// One truncated line, matching CapabilityInstanceRow, with the whole value one hover away (`title`). Live
// facts lead over stored ones: a connected tunnel opens with its address, a resting one with what it dials.
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

// A gateway that wants a token says so in the failure; the code field opens right where the user just failed.
const wantsCode = (id: string): boolean => /one-time code|2FA|token/i.test(failures[id] ?? ``);

// Same three verbs and glyph as CapabilityInstanceRow's menu, behind the ellipsis so the dial keeps the row's
// space. One shared ContextMenu for the list, opened over whichever row was pressed, not one per row.
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

// Shown beside the group's name, not as a row: RowGroup's divide-y would make it read as a half-drawn row.
const caption = computed(() =>
    links.value.some((link) => link.state === `connected`)
        ? `traffic matching a connected tunnel's routes leaves the sandbox through it: including the agent's`
        : undefined,
);
</script>

<template>
    <RowGroup label="Your connections" :count="rows.length" :caption="caption">
        <!-- The tunnels stay listed: this says the live half is missing, not the connections. -->
        <Notice v-if="listNotice" :of="listNotice" class="m-4" />
        <Row v-for="row in rows" :key="row.id" :icon="row.link?.state === 'connected' ? 'shield' : 'globe'" :selected="editingId === row.id">
            <!--
                Status rides the name, as elsewhere in the app, not beside the controls, which have the least space to
                spare.
            -->
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
                <!--
                    `block truncate`: an inline span can't ellipsise, so three routes would wrap under the row's button
                    instead.
                -->
                <span v-if="row.facts" class="block truncate font-mono" :title="row.facts">{{ row.facts }}</span>
                <!--
                    Wraps rather than truncates: the tail here is the way out of the state, not text an ellipsis should
                    hide.
                -->
                <span v-if="row.note === 'rebuild'" class="block text-warning">
                    Needs a sandbox rebuild to install its client:
                    <RouterLink to="/sandbox/environment" class="text-link hover:underline">finish setup →</RouterLink>
                </span>
                <span v-else-if="row.note === 'auto'" class="block">Connects automatically after a sandbox restart.</span>
            </template>
            <template #control>
                <!--
                    No dial until the link arrives; guessing Connect vs Disconnect from stored config risks the wrong
                    tunnel.
                -->
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
                    <!-- Client's own text (e.g. a --servercert digest); preserved verbatim and wrapped, not truncated. -->
                    <pre
                        v-if="failures[row.id]"
                        class="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger"
                        >{{ failures[row.id] }}</pre>
                    <div v-if="otpFor === row.id" class="flex items-center gap-2">
                        <!--
                            Prevents on keydown, not keyup: this list sits inside the card's form, so a bare Enter
                            would submit it.
                        -->
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
