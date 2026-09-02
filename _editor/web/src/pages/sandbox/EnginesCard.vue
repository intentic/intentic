<script setup lang="ts">
import { type EngineRow, EnginesViewSchema } from "@intentic-app/api-contract";
import { BrandMark, Button, Notice, type NoticeModel, Picker, type PickerOption, Row, RowGroup, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { ENGINES_KEY, useEngines } from "../../composables/sandbox/useEngines";
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

const queryClient = useQueryClient();
const { busy, notice, run } = useAsyncAction();
const { canShip: canOperate } = useRole();
const { engines, view, updatable, query, isFetching } = useEngines();

const actionNotice = computed<NoticeModel | undefined>(() =>
    notice.value?.detail === `not a sandbox maintainer`
        ? { tone: `warning`, title: `Only a sandbox maintainer can change which agent engines this sandbox runs.` }
        : notice.value,
);

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

// Every write answers with the whole view, so the card never has to guess what the daemon did with a request.
const post = (path: string, body: object): Promise<void> =>
    run(async () => {
        const answer = (await sandboxJson(path, jsonBody(`POST`, body))) as { engines: unknown };
        queryClient.setQueryData(ENGINES_KEY, EnginesViewSchema.parse(answer.engines));
    }, `Could not change this engine.`);

/* Pinning needs a version, and the honest one to pin is what is running right now — that is what an owner
 * means by "hold it here" when a newer release has just broken something for them. A row with nothing running
 * cannot be pinned at all, so the option is refused rather than sent as a pin to nothing. */
const setChannel = (engine: EngineRow, kind: `blessed` | `latest` | `pinned` | `image`): Promise<void> => {
    if (kind === `pinned` && engine.running.version === undefined) {
        return post(`/engines/channel`, { id: engine.id, kind: `image` });
    }
    return post(`/engines/channel`, {
        id: engine.id,
        kind,
        ...(kind === `pinned` ? { version: engine.running.version } : {}),
    });
};

const update = (engine: EngineRow): Promise<void> => post(`/engines/update`, { id: engine.id });
const revert = (engine: EngineRow): Promise<void> => post(`/engines/revert`, { id: engine.id });

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`;
</script>

<template>
    <RowGroup label="Agent engines">
        <template #actions>
            <div class="flex flex-wrap items-center justify-end gap-2">
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
                        :disabled="busy || !canOperate"
                        class="shrink-0"
                        :aria-label="`Where ${engine.label} gets its version`"
                        :header="`${engine.label} version source`"
                        @update:model-value="(kind) => kind !== undefined && setChannel(engine, kind)"
                    />
                    <Button
                        v-if="engine.offered"
                        size="sm"
                        :disabled="busy || !canOperate"
                        :label="`Update to ${engine.offered.version}`"
                        @click="update(engine)"
                    />
                    <Button
                        v-if="engine.previous || engine.running.source === `store`"
                        size="sm"
                        variant="ghost"
                        :disabled="busy || !canOperate"
                        :label="engine.previous ? `Back to ${engine.previous}` : `Back to the image's copy`"
                        @click="revert(engine)"
                    />
                    <span v-if="engine.diskBytes > 0" class="text-xs text-muted">{{ megabytes(engine.diskBytes) }} kept</span>
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
