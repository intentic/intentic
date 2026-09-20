<script setup lang="ts">
import type { CapabilitySummary } from "@intentic/api-contract";
import { Button, ContextMenu, Notice, type NoticeModel, Row, RowGroup, StatusBadge, type StatusVariant, ui } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import type { NetdiskLink } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { computed, reactive, ref } from "vue";
import { useNetdisk } from "../features/sandbox/devices/useNetdisk";
import { useT } from "@intentic/ui/i18n";

// Per-disk mounts list: where it is, whether it takes writes, and mount/unmount controls, not just a status dot. Rows
// come from the capability list, not /netdisk, which can lag or fail on its own, so a row exists before any live link
// arrives. Shares CapabilityInstanceRow's overflow menu; mounting streams progress.

const t = useT();

const props = defineProps<{
    /** The netdisk-kind capabilities on this card: what exists, and what each is called. */
    instances: readonly CapabilitySummary[];
    /** The disk the card's form is open over; wears the selected tint, as the generic row does. */
    editingId?: string | undefined;
}>();

const emit = defineEmits<{ edit: [id: string]; rename: [id: string]; remove: [id: string] }>();

const { links, mount, unmount, error: listError } = useNetdisk();
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: t(`common.netdiskMounts.couldntReadWhatDisks`), detail: listError.value },
);

// Per-disk local state, keyed by id, so one failing disk never blanks another's row.
const busy = reactive(new Set<string>());
const progress = reactive<Record<string, string>>({});
const failures = reactive<Record<string, string>>({});

const variantOf = (state: NetdiskLink[`state`]): StatusVariant => (state === `mounted` ? `success` : `neutral`);

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

const accessLabel = (writable: boolean): string => (writable ? t(`common.netdiskMounts.readWrite`) : t(`common.netdiskMounts.readOnly`));

// What the stored config alone can answer, for a row with no link yet. Read defensively: config is an open record.
const text = (instance: CapabilitySummary, key: string): string | undefined => {
    const value = instance.config[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};

interface MountRow {
    readonly id: string;
    /** ONE LINE, and the order is the point: see factsOfRow below. */
    readonly facts: string;
    /** The one thing worth a second line under this row, when there is one. */
    readonly note: `rebuild` | `auto` | `drifted` | undefined;
    /** Undefined until /netdisk answers for this one: the row exists, its live half does not yet. */
    readonly link: NetdiskLink | undefined;
}

// A second line is earned: rebuild is said whenever true; a drifted mount (writable though the card says read-only)
// outranks everything, since it is the promise this card makes; auto-mount only when resting.
const noteOf = (link: NetdiskLink | undefined): MountRow[`note`] => {
    if (link === undefined) {
        return undefined;
    }
    if (link.state === `unavailable`) {
        return `rebuild`;
    }
    if (link.state === `mounted` && link.writable === true && link.access === `read`) {
        return `drifted`;
    }
    return link.autoMount && link.state !== `mounted` ? `auto` : undefined;
};

// One truncated line, with the whole value one hover away (`title`). Live facts lead over stored ones: a mounted disk
// opens with where it is, a resting one with what it would mount.
const factsOfRow = (instance: CapabilitySummary, link: NetdiskLink | undefined): string => {
    const configured = text(instance, `access`) === `readwrite`;
    const target = link?.target ?? (text(instance, `server`) === undefined ? undefined : `//${text(instance, `server`)}/${text(instance, `share`) ?? ``}`);
    return [
        ...(link?.state === `mounted` ? [link.mountPoint, accessLabel(link.writable === true), uptime(link.since)] : [accessLabel(link === undefined ? configured : link.access === `readwrite`)]),
        target,
    ]
        .filter((fact): fact is string => fact !== undefined && fact !== ``)
        .join(` · `);
};

const rows = computed<MountRow[]>(() =>
    props.instances.map((instance) => {
        const link = links.value.find((candidate) => candidate.id === instance.id);
        return { id: instance.id, facts: factsOfRow(instance, link), note: noteOf(link), link };
    }),
);

const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (busy.has(id)) {
        return;
    }
    busy.add(id);
    delete failures[id];
    try {
        await action();
    } catch (caught) {
        failures[id] = errorMessage(caught, t(`common.netdiskMounts.actionFailed`));
    } finally {
        busy.delete(id);
        delete progress[id];
    }
};

const onMount = (id: string): Promise<void> =>
    run(id, () =>
        mount(id, (message) => {
            progress[id] = message;
        }),
    );

const onUnmount = (id: string): Promise<void> => run(id, () => unmount(id));

// Same three verbs and glyph as CapabilityInstanceRow's menu, behind the ellipsis so the mount button keeps the row's
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
        { label: t(`common.netdiskMounts.settings`), icon: `cog`, command: () => emit(`edit`, id) },
        { label: t(`common.netdiskMounts.rename`), icon: `pencil`, command: () => emit(`rename`, id) },
        { label: t(`ui.action.remove`), icon: `trash`, danger: true, command: () => emit(`remove`, id) },
    ];
});

// Shown beside the group's name, not as a row: a writable mount is the one thing here worth saying out loud.
const caption = computed(() =>
    links.value.some((link) => link.state === `mounted` && link.writable === true) ? t(`common.netdiskMounts.agentCanWriteCaption`) : undefined,
);
</script>

<template>
    <RowGroup :label="t(`common.netdiskMounts.disks`)" :caption="caption">
        <!-- The disks stay listed: this says the live half is missing, not the disks. -->
        <Notice v-if="listNotice" :of="listNotice" class="m-4" />
        <Row v-for="row in rows" :key="row.id" :icon="row.link?.state === 'mounted' ? 'server' : 'box'" :selected="editingId === row.id">
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <span class="truncate">{{ row.id }}</span>
                    <StatusBadge v-if="row.link" size="xs" dot :variant="variantOf(row.link.state)" :label="row.link.state" v-tooltip.top="row.link.detail" />
                </span>
            </template>
            <template #description>
                <span v-if="row.facts" class="block truncate font-mono" :title="row.facts">{{ row.facts }}</span>
                <span v-if="row.note === 'rebuild'" class="block text-warning">
                    {{ t(`common.netdiskMounts.needsSandboxRebuildTo`) }}
                    <RouterLink to="/sandbox/environment" class="text-link hover:underline">{{ t(`common.netdiskMounts.finishSetup`) }}</RouterLink>
                </span>
                <span v-else-if="row.note === 'drifted'" class="block text-danger">{{ t(`common.netdiskMounts.mountedWritableThoughReadOnly`) }}</span>
                <span v-else-if="row.note === 'auto'" class="block">{{ t(`common.netdiskMounts.mountsAutomaticallyAfterSandbox`) }}</span>
            </template>
            <template #control>
                <!-- No button until the link arrives; guessing Mount vs Unmount from stored config risks the wrong disk. -->
                <div class="flex shrink-0 items-center gap-1">
                    <Button
                        v-if="row.link?.state === 'mounted'"
                        :label="t(`common.netdiskMounts.unmount`)"
                        size="small"
                        :text="true"
                        :loading="busy.has(row.id)"
                        @click="onUnmount(row.id)"
                    />
                    <Button
                        v-else-if="row.link"
                        :label="t(`common.netdiskMounts.mount`)"
                        size="small"
                        :text="true"
                        :disabled="row.link.state === 'unavailable'"
                        :loading="busy.has(row.id)"
                        @click="onMount(row.id)"
                    />
                    <button type="button" :class="ui.iconButton()" :aria-label="t(`common.netdiskMounts.moreActions`)" @click="openMenu(row.id, $event)">
                        <Icon name="ellipsis" />
                    </button>
                </div>
            </template>
            <template v-if="progress[row.id] || failures[row.id]" #below>
                <div class="mt-2 flex flex-col gap-2">
                    <p v-if="progress[row.id]" class="font-mono text-2xs text-subtle">{{ progress[row.id] }}</p>
                    <!-- mount.cifs's own text plus the daemon's advice; preserved verbatim and wrapped, not truncated. -->
                    <pre
                        v-if="failures[row.id]"
                        class="max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger"
                        >{{ failures[row.id] }}</pre>
                </div>
            </template>
        </Row>
        <ContextMenu ref="menu" :model="items" :min-width="11" />
    </RowGroup>
</template>
