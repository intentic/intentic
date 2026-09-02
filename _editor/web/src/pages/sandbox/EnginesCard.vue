<script setup lang="ts">
import { type EngineRow, EnginesViewSchema } from "@intentic-app/api-contract";
import { Button, Card, Notice, type NoticeModel, Picker, type PickerOption, Row, StatusBadge, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { ENGINES_KEY, useEngines } from "../../composables/sandbox/useEngines";
import { useRole } from "../../composables/sandbox/useRole";

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
    <Card class="flex flex-col gap-4">
        <Row flush :heading="2" icon="cpu" title="Agent engines">
            <template #control>
                <StatusBadge
                    v-if="updatable.length"
                    variant="warning"
                    :label="`${updatable.length} update${updatable.length === 1 ? `` : `s`}`"
                    dot
                />
                <button type="button" :class="ui.iconButton()" aria-label="Refresh" v-tooltip.top="'Refresh'" @click="query.refetch()">
                    <Icon name="refresh" class="text-sm" :spin="isFetching" />
                </button>
            </template>
        </Row>

        <ul class="flex flex-col divide-y divide-line">
            <li v-for="engine in engines" :key="engine.id" class="py-3 first:pt-0 last:pb-0">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span class="text-sm font-medium">{{ engine.label }}</span>
                    <span v-if="engine.running.version" class="font-mono text-xs text-muted">{{ engine.running.version }}</span>
                    <!-- The one state that is neither a version nor a fault: a core image that bakes no copy of
                         this engine, where the store is the only way to get one. -->
                    <span v-else class="text-xs text-muted">not installed here</span>
                    <StatusBadge v-if="engine.running.source === `store`" variant="info" label="installed" />
                    <StatusBadge v-else-if="engine.running.version" variant="neutral" label="from image" />
                    <!-- Says which claim the running version carries, because on the latest channel the answer
                         is routinely "nobody has tested this here" and the row must not imply otherwise. -->
                    <StatusBadge
                        v-if="engine.running.version && engine.blessed && engine.running.version !== engine.blessed"
                        variant="warning"
                        label="not recommended"
                    />

                    <div class="ml-auto flex flex-wrap items-center gap-2">
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
                    </div>
                </div>

                <!-- A version this sandbox installed and then refused. Shown because the alternative is an
                     unexplained downgrade: the row would say "from image" and nothing would say why.

                     break-words, because the reason usually ENDS in a store path — one unbroken token longer
                     than a phone's viewport, which ran out past the card's own border before this. -->
                <p v-for="refused in engine.quarantined" :key="refused.version" class="mt-2 text-xs break-words text-muted">
                    {{ refused.version }} was refused: {{ refused.reason }}
                </p>
            </li>
        </ul>

        <Notice v-if="actionNotice" v-bind="actionNotice" />

        <p v-if="view?.listReadAt === undefined" class="text-xs break-words text-muted">
            The recommended list at {{ view?.listSource }} has not been reachable from here, so recommended rows are showing whatever they last knew.
        </p>
    </Card>
</template>
