<script setup lang="ts">
import type { EngineRow } from "@intentic/api-contract";
import { BrandMark, Button, Notice, Picker, type PickerOption, Row, RowGroup, SkeletonRows, StatusBadge, ui } from "@intentic/ui";
import { useEngines } from "./useEngines";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useRole } from "../secrets/useRole";
import { useHubWork } from "../../../shell/hub/hubWork";
import { engineVisual } from "./engineVisual";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// Agent engines this sandbox runs, and where each version comes from (the image bake vs. this machine's
// store). Each row shows what's running, its channel (recommended/latest/pinned/image), and a revert.
// Changing a channel is owner-only; a viewer still sees the running versions.

const t = useT();

const { canShip: canOperate } = useRole();
const {
    engines,
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

// A version swap is a download and an install, not a settings write, so it is reported to the row holding this card
// and keeps its mark while the reader is off reading something else.
const hubWork = useHubWork();
const runUpdate = (engine: EngineRow): Promise<void> => hubWork.track(`Updating ${engine.label}`, () => update(engine));
const runRevert = (engine: EngineRow): Promise<void> => hubWork.track(`Reverting ${engine.label}`, () => revert(engine));
const runUpdateAll = (): Promise<void> => hubWork.track(`Updating agent engines`, () => updateAll());

const CHANNELS = computed((): readonly PickerOption<`blessed` | `latest` | `pinned` | `image`>[] => [
    {
        label: t(`sandbox.enginesCard.recommended`),
        value: `blessed`,
        icon: `check`,
        hint: t(`sandbox.enginesCard.intenticTestedUpdatesIn`),
    },
    {
        label: t(`shared.latest`),
        value: `latest`,
        icon: `download`,
        hint: t(`sandbox.enginesCard.upstreamsNewestRelease`),
    },
    { label: t(`sandbox.enginesCard.pinned`), value: `pinned`, icon: `lock`, hint: t(`sandbox.enginesCard.freezeRunningVersion`) },
    { label: t(`shared.image2`), value: `image`, icon: `box`, hint: t(`sandbox.enginesCard.imageCopyOnly`) },
]);
</script>

<template>
    <RowGroup :label="t(`sandbox.enginesCard.agentEngines`)">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
                <Button
                    v-if="updatable.length > 0"
                    size="small"
                    :loading="updatingAll"
                    :disabled="isAnyBusy || !canOperate"
                    :label="t(`sandbox.enginesCard.updateAll`)"
                    @click="runUpdateAll"
                />
                <StatusBadge
                    v-if="updatable.length"
                    variant="warning"
                    :label="t(`sandbox.enginesCard.updates`, { count: updatable.length }, updatable.length)"
                    dot
                />
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`ui.action.refresh`)"
                    v-tooltip.top="t(`ui.action.refresh`)"
                    @click="query.refetch()"
                >
                    <Icon name="refresh" class="text-sm" :spin="isFetching" />
                </button>
            </div>
        </template>

        <div v-if="isLoading" role="status" aria-busy="true">
            <template v-if="outline">
                <span class="sr-only">{{ t(`sandbox.enginesCard.readingSandboxsAgentEngines`) }}</span>
                <SkeletonRows :rows="5" description control />
            </template>
        </div>

        <Row v-for="engine in engines" v-else :key="engine.id">
            <template #lead="{ mark }">
                <BrandMark :size="mark" :name="engine.label" :logo="engineVisual(engine.id).logo" :icon="engineVisual(engine.id).icon" />
            </template>
            <template #title>
                <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span class="text-xs">{{ engine.label }}</span>
                    <StatusBadge v-if="engine.running.source === `store`" variant="info" size="xs" :label="t(`sandbox.enginesCard.installed`)" />
                    <StatusBadge v-else-if="engine.running.version" variant="neutral" size="xs" :label="t(`sandbox.enginesCard.image`)" />
                    <StatusBadge
                        v-if="engine.running.version && engine.blessed && engine.running.version !== engine.blessed"
                        variant="warning"
                        size="xs"
                        :label="t(`sandbox.enginesCard.notRecommended`)"
                    />
                </span>
            </template>
            <template #description>
                <span v-if="engine.running.version" class="font-mono">{{ engine.running.version }}</span>
                <span v-else>{{ t(`sandbox.enginesCard.notInstalledHere`) }}</span>
            </template>
            <template #control>
                <Picker
                    :model-value="engine.channel.kind"
                    :options="CHANNELS"
                    variant="ghost"
                    :disabled="isEngineBusy(engine) || !canOperate"
                    class="shrink-0"
                    :aria-label="t(`sandbox.enginesCard.whereGetsVersion`, { label: engine.label })"
                    :header="t(`sandbox.enginesCard.versionSource`, { label: engine.label })"
                    @update:model-value="(kind) => kind !== undefined && setChannel(engine, kind)"
                />
                <Button
                    v-if="engine.offered"
                    size="small"
                    :loading="isEngineUpdating(engine)"
                    :disabled="isEngineBusy(engine) || !canOperate"
                    :label="t(`sandbox.enginesCard.updateTo`, { version: engine.offered.version })"
                    @click="runUpdate(engine)"
                />
                <Button
                    v-if="engine.previous || engine.running.source === `store`"
                    size="small"
                    severity="secondary"
                    :loading="isEngineReverting(engine)"
                    :disabled="isEngineBusy(engine) || !canOperate"
                    :label="
                        engine.previous ? t(`sandbox.enginesCard.backTo`, { previous: engine.previous }) : t(`sandbox.enginesCard.backToImagesCopy`)
                    "
                    @click="runRevert(engine)"
                />
            </template>
            <template v-if="engine.quarantined.length > 0" #below>
                <p v-for="refused in engine.quarantined" :key="refused.version" class="text-xs break-words text-muted">
                    {{ t(`sandbox.enginesCard.refused`, { version: refused.version, reason: refused.reason }) }}
                </p>
            </template>
        </Row>

        <Notice v-if="actionNotice" :of="actionNotice" class="m-3" />
    </RowGroup>
</template>
