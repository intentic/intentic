<script setup lang="ts">
import type { EngineRow } from "@intentic-app/api-contract";
import { BrandMark, Button, Notice, Picker, type PickerOption, Row, RowGroup, StatusBadge, ui } from "@intentic/ui";
import { useEngines } from "../../composables/sandbox/useEngines";
import { useRole } from "../../composables/sandbox/useRole";
import { engineVisual } from "./engineVisual";

/* THE AGENT ENGINES this sandbox runs, and where each one's version comes from.
 *
 * The card exists because that question used to have one answer for everybody: whatever the sandbox image
 * baked. When Anthropic raised the version floor a model requires, every sandbox in the fleet failed every
 * Claude turn until a new image reached it — an upstream event, an outage here, and nothing an owner could do
 * about it from inside their own box.
 *
 * So each row says three things and offers three actions. What is RUNNING (and whether it came from the image
 * or from the store on this machine's volume), what its CHANNEL would move it to, and what going BACK means.
 * Recommended is the default and means "a version this project's suite has run against"; latest takes upstream's
 * newest without waiting for anyone to recommend it; pinned holds one still. Nothing here downloads without a
 * click except what the channel already said to take.
 *
 * Owner-only, like the environment decisions above it: this installs code that every turn in this sandbox then
 * runs. A viewer still sees the versions, which is the half that answers "why did my turn fail". */

const { canShip: canOperate } = useRole();
const {
    engines,
    view,
    updatable,
    query,
    isFetching,
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

        <Row v-for="engine in engines" :key="engine.id">
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
