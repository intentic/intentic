<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAreas } from "../areas/useAreas";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// WHERE ONE PERSON MAY LOOK: the whole workspace, or the areas ticked. Their agents run inside the same fence (the
// daemon's sandbox for a fenced turn holds those folders and nothing else). For a person who only chats with assistants
// the areas are the whole of the access, so there is no "whole workspace" to pick, and each area says who works there.

const t = useT();

const { picked, chat, disabled = false } = defineProps<{ picked: readonly string[] | undefined; chat: boolean; disabled?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [areas: string[] | undefined] }>();

const { areas } = useAreas();
const { namesOf } = usePersonaReach();

const held = computed<readonly string[]>(() => picked ?? []);
const reached = computed<string[]>(() => namesOf(picked));
// Every area a dead end for a chat: said once, up front, instead of letting the owner find it row by row.
const nobodyAnywhere = computed(() => chat && areas.value.every((area) => namesOf([area.id]).length === 0));

type Scope = `whole` | `some`;
const scope = computed<Scope>(() => (picked === undefined && !chat ? `whole` : `some`));
const SCOPES = computed(() => [
    { value: `whole` as const, label: t(`sandbox.sandboxAccess.wholeWorkspace`), icon: `globe` as const },
    { value: `some` as const, label: t(`sandbox.sandboxAccess.onlySomeAreas`), icon: `folder` as const },
]);
// Narrowing starts from nothing ticked rather than every area: a fence that silently held them all would read as
// narrowed while reaching everything.
const pickScope = (next: Scope): void => emit(`change`, next === `whole` ? undefined : [...held.value]);

// Who each area hands a chat, on its row: for that access the assistants ARE what is reached.
const reachOf = (id: string): string => {
    const names = namesOf([id]);
    return names.length === 0 ? t(`sandbox.sandboxAccess.areaNoAssistant`) : names.join(`, `);
};

const toggle = (id: string, on: boolean): void => {
    emit(`change`, on ? [...new Set([...held.value, id])] : held.value.filter((area) => area !== id));
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <p v-if="areas.length === 0" class="text-xs text-muted">
            {{ t(`sandbox.sandboxAccess.noAreasToGrant`) }}
            <RouterLink to="/sandbox/areas" class="text-content underline">{{ t(`sandbox.sandboxAccess.nameOne`) }}</RouterLink>
        </p>
        <template v-else>
            <SegmentedControl
                v-if="!chat"
                :model-value="scope"
                :options="SCOPES"
                :class="{ 'pointer-events-none opacity-60': disabled }"
                @update:model-value="pickScope"
            />
            <!-- Ticks on rows, not chips: each area is read with its folders, and for a chat with who works there. -->
            <div v-if="scope === `some`" class="-mx-2.5 flex flex-col gap-0.5" role="group" :aria-label="t(`sandbox.sandboxAccess.seeSection`)">
                <label
                    v-for="area in areas"
                    :key="area.id"
                    class="ui-row-select flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5"
                    :class="{ 'ui-row-select-on': held.includes(area.id), 'pointer-events-none opacity-60': disabled }"
                >
                    <Checkbox
                        :model-value="held.includes(area.id)"
                        binary
                        size="small"
                        :disabled="disabled"
                        @update:model-value="(on: unknown) => toggle(area.id, on === true)"
                    />
                    <span class="flex min-w-0 flex-1 items-baseline gap-2">
                        <span class="text-sm text-content">{{ area.label ?? area.id }}</span>
                        <span class="truncate font-mono text-2xs text-subtle">{{ area.folders.join(`, `) }}</span>
                    </span>
                    <span v-if="chat" class="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
                        <Icon name="comments" class="text-2xs" />{{ reachOf(area.id) }}
                    </span>
                </label>
            </div>

            <!-- What the pick hands over. Guidance stays quiet until a pick is actually wrong. -->
            <p v-if="nobodyAnywhere" class="text-xs text-muted">
                {{ t(`sandbox.sandboxAccess.guestHasNobodyAnywhere`) }}
                <RouterLink to="/sandbox/personas" class="text-content underline">{{ t(`sandbox.sandboxAccess.giveAssistantFolder`) }}</RouterLink>
            </p>
            <p v-else-if="chat && held.length > 0 && reached.length === 0" class="ui-field-error">{{ t(`sandbox.sandboxAccess.noAssistantWorksHere`) }}</p>
            <p v-else-if="chat && reached.length > 0" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.fenceHoldsAssistants`, { names: reached.join(`, `) }) }}</p>
            <p v-else-if="!chat" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.agentsSeeSame`) }}</p>
        </template>
    </div>
</template>
