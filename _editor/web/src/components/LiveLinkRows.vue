<script setup lang="ts" generic="K extends LinkKind">
import type { CapabilitySummary } from "@intentic/api-contract";
import type { VpnLink } from "@intentic/sandbox-contract";
import { Button, ContextMenu, type IconName, Notice, type NoticeModel, Row, RowGroup, StatusBadge, type StatusVariant, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, reactive, ref } from "vue";
import { type LinkKind, type LinkOf, useLiveLinks } from "../features/sandbox/devices/useLiveLinks";

// Rows come from the capability list, not the live read, which can lag or fail on its own: a row exists before its link.

const t = useT();

const props = defineProps<{
    kind: K;
    /** This card's capabilities of that kind: what exists, and what each is called. */
    instances: readonly CapabilitySummary[];
    /** The one the card's form is open over; wears the selected tint, as the generic row does. */
    editingId?: string | undefined;
}>();

const emit = defineEmits<{ edit: [id: string]; rename: [id: string]; remove: [id: string] }>();

interface KindSpec<L> {
    readonly group: () => string;
    readonly listFailed: () => string;
    readonly failed: () => string;
    readonly open: () => string;
    readonly close: () => string;
    readonly autoNote: () => string;
    // Whether the link is up or on its way, which offers close rather than open.
    readonly up: (link: L) => boolean;
    readonly auto: (link: L) => boolean;
    // A live state that breaks a promise the card makes; outranks every other note.
    readonly drifted: (link: L) => boolean;
    readonly variant: (link: L) => StatusVariant;
    readonly icon: (link: L | undefined) => IconName;
    // Live facts lead over stored ones: an open link starts with where it is, a resting one with what it would open.
    readonly facts: (instance: CapabilitySummary, link: L | undefined) => (string | undefined)[];
    readonly caption: (links: readonly L[]) => string | undefined;
    // A gateway that can ask for a one-time code in its failure.
    readonly otp: boolean;
}

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

// Config is an open record, not a typed link config, so each value is read defensively.
const text = (instance: CapabilitySummary, key: string): string | undefined => {
    const value = instance.config[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};

const PROVIDER_LABEL: Record<VpnLink[`provider`], string> = { wireguard: `WireGuard`, fortinet: `FortiGate SSL-VPN`, ipsec: `IPsec` };

const access = (writable: boolean): string => (writable ? t(`common.netdiskMounts.readWrite`) : t(`common.netdiskMounts.readOnly`));

const SPECS: { readonly [P in LinkKind]: KindSpec<LinkOf[P]> } = {
    vpn: {
        group: () => t(`shared.connections`),
        listFailed: () => t(`common.vpnConnections.couldntReadWhatTunnels`),
        failed: () => `The VPN action failed.`,
        open: () => t(`ui.action.connect`),
        close: () => t(`ui.action.disconnect`),
        autoNote: () => t(`common.vpnConnections.connectsAutomaticallyAfterSandbox`),
        up: (link) => link.state === `connected` || link.state === `connecting`,
        auto: (link) => link.autoConnect,
        drifted: () => false,
        variant: (link) =>
            link.state === `connected` ? `success` : link.state === `failed` ? `danger` : link.state === `connecting` ? `warning` : `neutral`,
        icon: (link) => (link?.state === `connected` ? `shield` : `globe`),
        facts: (instance, link) => {
            const provider = link?.provider ?? text(instance, `provider`);
            return [
                ...(link === undefined
                    ? []
                    : [
                          link.address,
                          // Full-tunnel is named, since 0.0.0.0/0 is the most consequential thing a VPN can do here.
                          link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.length > 0 ? link.routes.join(`, `) : undefined,
                          link.interface,
                          uptime(link.since),
                      ]),
                provider !== undefined && provider in PROVIDER_LABEL ? PROVIDER_LABEL[provider as VpnLink[`provider`]] : provider,
                link?.gateway ?? text(instance, `gateway`),
            ];
        },
        caption: (links) =>
            links.some((link) => link.state === `connected`)
                ? `traffic matching a connected tunnel's routes leaves the sandbox through it: including the agent's`
                : undefined,
        otp: true,
    },
    netdisk: {
        group: () => t(`common.netdiskMounts.disks`),
        listFailed: () => t(`common.netdiskMounts.couldntReadWhatDisks`),
        failed: () => t(`common.netdiskMounts.actionFailed`),
        open: () => t(`common.netdiskMounts.mount`),
        close: () => t(`common.netdiskMounts.unmount`),
        autoNote: () => t(`common.netdiskMounts.mountsAutomaticallyAfterSandbox`),
        up: (link) => link.state === `mounted`,
        auto: (link) => link.autoMount,
        drifted: (link) => link.state === `mounted` && link.writable === true && link.access === `read`,
        variant: (link) => (link.state === `mounted` ? `success` : `neutral`),
        icon: (link) => (link?.state === `mounted` ? `server` : `box`),
        facts: (instance, link) => {
            const server = text(instance, `server`);
            return [
                ...(link?.state === `mounted`
                    ? [link.mountPoint, access(link.writable === true), uptime(link.since)]
                    : [access(link === undefined ? text(instance, `access`) === `readwrite` : link.access === `readwrite`)]),
                link?.target ?? (server === undefined ? undefined : `//${server}/${text(instance, `share`) ?? ``}`),
            ];
        },
        caption: (links) =>
            links.some((link) => link.state === `mounted` && link.writable === true) ? t(`common.netdiskMounts.agentCanWriteCaption`) : undefined,
        otp: false,
    },
};

const spec = computed(() => SPECS[props.kind]);
const { links, open, close, error: listError } = useLiveLinks(props.kind);
// The list query reports a bare message; this card knows what the user came to see.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: spec.value.listFailed(), detail: listError.value },
);

// Per-link local state, keyed by id, so one failing link never blanks another's row.
const busy = reactive(new Set<string>());
const progress = reactive<Record<string, string>>({});
const failures = reactive<Record<string, string>>({});
// Which tunnel's code field is open, and its value; never stored, it goes straight into the dial.
const otpFor = ref<string>();
const otp = ref(``);

interface LinkRow {
    readonly id: string;
    /** ONE truncated line, the whole value one hover away. */
    readonly facts: string;
    /** The one thing worth a second line under this row: rebuild whenever true, auto only while resting. */
    readonly note: `rebuild` | `drifted` | `auto` | undefined;
    /** Undefined until the live read answers for this one. */
    readonly link: LinkOf[K] | undefined;
}

const noteOf = (link: LinkOf[K] | undefined): LinkRow[`note`] => {
    if (link === undefined) {
        return undefined;
    }
    if (link.state === `unavailable`) {
        return `rebuild`;
    }
    if (spec.value.drifted(link)) {
        return `drifted`;
    }
    return spec.value.auto(link) && !spec.value.up(link) ? `auto` : undefined;
};

const rows = computed<LinkRow[]>(() =>
    props.instances.map((instance) => {
        const link = links.value.find((candidate) => candidate.id === instance.id);
        const facts = spec.value.facts(instance, link).filter((fact): fact is string => fact !== undefined && fact !== ``);
        return { id: instance.id, facts: facts.join(` · `), note: noteOf(link), link };
    }),
);

// Per link, not globally: opening one while another is mid-open is fine, opening the same one twice is not.
const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (busy.has(id)) {
        return;
    }
    busy.add(id);
    delete failures[id];
    try {
        await action();
    } catch (caught) {
        failures[id] = errorMessage(caught, spec.value.failed());
    } finally {
        busy.delete(id);
        delete progress[id];
    }
};

const onOpen = async (id: string): Promise<void> => {
    const code = otpFor.value === id ? otp.value.trim() : ``;
    await run(id, () =>
        open(
            id,
            (message) => {
                progress[id] = message;
            },
            code === `` ? undefined : code,
        ),
    );
    otpFor.value = undefined;
    otp.value = ``;
};

// A gateway that wants a token says so in the failure; the code field opens right where the user just failed.
const wantsCode = (id: string): boolean => spec.value.otp && /one-time code|2FA|token/i.test(failures[id] ?? ``);

// One shared ContextMenu for the list, opened over whichever row was pressed, with CapabilityInstanceRow's three verbs.
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuFor = ref<string>();
const openMenu = (id: string, event: Event): void => {
    menuFor.value = id;
    menu.value?.show(event);
};
const items = computed<MenuItem[]>(() => {
    const id = menuFor.value ?? ``;
    return [
        { label: t(`ui.action.settings`), icon: `cog`, command: () => emit(`edit`, id) },
        { label: t(`ui.action.renameEllipsis`), icon: `pencil`, command: () => emit(`rename`, id) },
        { label: t(`ui.action.remove`), icon: `trash`, danger: true, command: () => emit(`remove`, id) },
    ];
});
</script>

<template>
    <RowGroup :label="spec.group()" :caption="spec.caption(links)">
        <!-- The links stay listed: this says the live half is missing, not the capabilities. -->
        <Notice v-if="listNotice" :of="listNotice" class="m-4" />
        <Row v-for="row in rows" :key="row.id" :icon="spec.icon(row.link)" :selected="editingId === row.id">
            <!-- Status rides the name, as elsewhere in the app, not beside the controls, which have the least space to spare. -->
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <span class="truncate">{{ row.id }}</span>
                    <StatusBadge
                        v-if="row.link"
                        size="xs"
                        dot
                        :variant="spec.variant(row.link)"
                        :label="row.link.state"
                        v-tooltip.top="row.link.detail"
                    />
                </span>
            </template>
            <template #description>
                <!-- `block truncate`: an inline span can't ellipsise, so three routes would wrap under the row's button instead. -->
                <span v-if="row.facts" class="block truncate font-mono" :title="row.facts">{{ row.facts }}</span>
                <!-- Wraps rather than truncates: the tail here is the way out of the state, not text an ellipsis should hide. -->
                <span v-if="row.note === 'rebuild'" class="block text-warning">
                    {{ t(`common.vpnConnections.needsSandboxRebuildTo`) }}
                    <RouterLink to="/sandbox/environment" class="text-link hover:underline">{{ t(`common.vpnConnections.finishSetup`) }}</RouterLink>
                </span>
                <span v-else-if="row.note === 'drifted'" class="block text-danger">{{
                    t(`common.netdiskMounts.mountedWritableThoughReadOnly`)
                }}</span>
                <span v-else-if="row.note === 'auto'" class="block">{{ spec.autoNote() }}</span>
            </template>
            <template #control>
                <!-- No button until the link arrives; guessing open vs close from stored config risks the wrong link. -->
                <div class="flex shrink-0 items-center gap-1">
                    <Button
                        v-if="row.link && spec.up(row.link)"
                        :label="spec.close()"
                        size="small"
                        :text="true"
                        :loading="busy.has(row.id)"
                        @click="run(row.id, () => close(row.id))"
                    />
                    <Button
                        v-else-if="row.link"
                        :label="spec.open()"
                        size="small"
                        :text="true"
                        :disabled="row.link.state === 'unavailable'"
                        :loading="busy.has(row.id)"
                        @click="onOpen(row.id)"
                    />
                    <button type="button" :class="ui.iconButton()" :aria-label="t(`ui.action.moreActions`)" @click="openMenu(row.id, $event)">
                        <Icon name="ellipsis" />
                    </button>
                </div>
            </template>
            <template v-if="progress[row.id] || failures[row.id] || otpFor === row.id" #below>
                <div class="mt-2 flex flex-col gap-2">
                    <p v-if="progress[row.id]" class="font-mono text-2xs text-subtle">{{ progress[row.id] }}</p>
                    <!-- The client's own text (a --servercert digest, mount.cifs's advice); preserved verbatim and wrapped, not truncated. -->
                    <pre
                        v-if="failures[row.id]"
                        class="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger"
                        >{{ failures[row.id] }}</pre>
                    <div v-if="otpFor === row.id" class="flex items-center gap-2">
                        <!-- Prevents on keydown, not keyup: this list sits inside the card's form, so a bare Enter would submit it. -->
                        <input
                            v-model="otp"
                            :class="ui.input('w-32 font-mono')"
                            placeholder="123456"
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            @keydown.enter.prevent="onOpen(row.id)"
                        />
                        <Button :label="t(`common.vpnConnections.connectCode`)" size="small" :loading="busy.has(row.id)" @click="onOpen(row.id)" />
                        <Button :label="t(`ui.action.cancel`)" size="small" severity="secondary" :text="true" @click="otpFor = undefined" />
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
                        <Icon name="key" /> {{ t(`common.vpnConnections.enterOneTimeCode`) }}
                    </button>
                </div>
            </template>
        </Row>
        <ContextMenu ref="menu" :model="items" :min-width="11" />
    </RowGroup>
</template>
