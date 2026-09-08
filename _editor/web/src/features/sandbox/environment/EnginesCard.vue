<script setup lang="ts">
import type { EngineRow } from "@intentic/api-contract";
import { BrandMark, Button, Notice, Picker, type PickerOption, Row, RowGroup, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { useEngines } from "./useEngines";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useRole } from "../secrets/useRole";
import { engineVisual } from "./engineVisual";

// Agent engines this sandbox runs, and where each version comes from (the image bake vs. this machine's
// store). Each row shows what's running, its channel (recommended/latest/pinned/image), and a revert.
// Changing a channel is owner-only; a viewer still sees the running versions.

const { canShip: canOperate } = useRole();
const {
    engines,
    view,
    updatable,
    query,
    isFetching,
    isLoading,
    isAnyBusy,
    updatingAll,
    actionNotice,
    isEngineUpdating,
    isEngineReverting,
    isEngineBusy,
    setChannel,
    update,
    revert,
    updateAll,
} = useEngines();

const outline = useSandboxOutline(isLoading);

const CHANNELS: readonly PickerOption<`blessed` | `latest` | `pinned` | `image`>[] = [
    {
        label: `Recommended`,
        value: `blessed`,
        icon: `check`,
        hint: `Intentic-tested. Updates in place.`,
    },
    {
        label: `Latest`,
        value: `latest`,
        icon: `download`,
        hint: `Upstream's newest release.`,
    },
    { label: `Pinned`, value: `pinned`, icon: `lock`, hint: `Freeze the running version.` },
    { label: `Image`, value: `image`, icon: `box`, hint: `Image copy only.` },
];
</script>

<template>
    <RowGroup label="Agent engines">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <Button
                    v-if="updatable.length > 0"
                    size="small"
                    :loading="updatingAll"
                    :disabled="isAnyBusy || !canOperate"
                    label="Update all"
                    @click="updateAll"
                />
                <StatusBadge
                    v-if="updatable.length"
                    variant="warning"
                    :label="`${updatable.length} update${updatable.length === 1 ? `` : `s`}`"
                    dot
                />
                <button type="button" :class="ui.iconButton()" aria-label="Refresh" v-tooltip.top="'Refresh'" @click="query.refetch()">
                    <Icon name="refresh" class="text-sm" :spin="isFetching" />
                </button>
            </div>
        </template>

        <div v-if="isLoading" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">Reading this sandbox's agent engines…</span>
                <SkeletonRows :rows="5" description control />
            </template>
        </div>

        <Row v-for="engine in engines" v-else :key="engine.id">
                <template #lead="{ mark }">
                    <BrandMark :size="mark" :name="engine.label" :logo="engineVisual(engine.id).logo" :icon="engineVisual(engine.id).icon" />
                </template>
                <template #title
                    ><span class="text-xs">{{ engine.label }}</span></template
                >
                <template #description>
                    <span v-if="engine.running.version" class="font-mono">{{ engine.running.version }}</span>
                    <span v-else>not installed here</span>
                </template>
                <template #meta>
                    <StatusBadge v-if="engine.running.source === `store`" variant="info" label="installed" />
                    <StatusBadge v-else-if="engine.running.version" variant="neutral" label="from image" />
                    <StatusBadge
                        v-if="engine.running.version && engine.blessed && engine.running.version !== engine.blessed"
                        variant="warning"
                        label="not recommended"
                    />
                </template>
                <template #control>
                    <Picker
                        :model-value="engine.channel.kind"
                        :options="CHANNELS"
                        variant="ghost"
                        :disabled="isEngineBusy(engine) || !canOperate"
                        class="shrink-0"
                        :aria-label="`Where ${engine.label} gets its version`"
                        :header="`${engine.label} version source`"
                        @update:model-value="(kind) => kind !== undefined && setChannel(engine, kind)"
                    />
                    <Button
                        v-if="engine.offered"
                        size="small"
                        :loading="isEngineUpdating(engine)"
                        :disabled="isEngineBusy(engine) || !canOperate"
                        :label="`Update to ${engine.offered.version}`"
                        @click="update(engine)"
                    />
                    <Button
                        v-if="engine.previous || engine.running.source === `store`"
                        size="small"
                        severity="secondary"
                        :loading="isEngineReverting(engine)"
                        :disabled="isEngineBusy(engine) || !canOperate"
                        :label="engine.previous ? `Back to ${engine.previous}` : `Back to the image's copy`"
                        @click="revert(engine)"
                    />
                </template>
                <template v-if="engine.quarantined.length > 0" #below>
                    <p v-for="refused in engine.quarantined" :key="refused.version" class="text-xs break-words text-muted">
                        {{ refused.version }} was refused: {{ refused.reason }}
                    </p>
                </template>
        </Row>

        <Notice v-if="actionNotice" :of="actionNotice" class="m-3" />

        <p v-if="view?.listReadAt === undefined" class="mx-4 mb-4 text-xs break-words text-muted">
            The recommended list at {{ view?.listSource }} has not been reachable from here, so recommended rows are showing whatever they last knew.
        </p>
    </RowGroup>
</template>
