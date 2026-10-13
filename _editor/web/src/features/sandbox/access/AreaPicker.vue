<script setup lang="ts">
import type { GrantedRole } from "@intentic/sandbox-contract";
import { SegmentedControl } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAreas } from "../areas/useAreas";
import { roleNeedsAreas } from "./accessGrant";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// WHERE ONE PERSON WORKS, as the person dialog asks it: the whole workspace, or the areas ticked below. The fence is the
// same one their assistants run inside (the daemon's sandbox for a fenced turn holds those folders and nothing else),
// so the line under the list names what the pick hands over in assistants: the one consequence the control itself
// cannot show. A writer and a guest have no "whole workspace" to pick: for them the areas are the tier.

const t = useT();

const { picked, role, disabled = false } = defineProps<{ picked: readonly string[] | undefined; role: GrantedRole; disabled?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [areas: string[] | undefined] }>();

const { areas } = useAreas();
const { namesOf } = usePersonaReach();

const held = computed<readonly string[]>(() => picked ?? []);
const reached = computed<string[]>(() => namesOf(picked));
const needsOne = computed(() => roleNeedsAreas(role));
// A guest reaches its assistants and nothing else, so a fence that holds none is a grant with nothing behind it.
const strandsDesk = computed(() => role === `guest` && held.value.length > 0 && reached.value.length === 0);
// Every area a dead end for a guest: said once, up front, instead of letting the owner find it row by row.
const nobodyAnywhere = computed(() => role === `guest` && areas.value.every((area) => namesOf([area.id]).length === 0));

type Scope = `whole` | `some`;
const scope = computed<Scope>(() => (picked === undefined && !needsOne.value ? `whole` : `some`));
const SCOPES = computed(() => [
    { value: `whole` as const, label: t(`sandbox.sandboxAccess.wholeWorkspace`), icon: `globe` as const },
    { value: `some` as const, label: t(`sandbox.sandboxAccess.onlySomeAreas`), icon: `folder` as const },
]);
// Choosing "some" starts from nothing ticked rather than every area: the next press names the first one, and a fence
// that silently held them all would read as narrowed while reaching everything.
const pickScope = (next: Scope): void => emit(`change`, next === `whole` ? undefined : [...held.value]);

// Who each area hands a guest, on its row: for that tier the assistants ARE the access, so an area nobody works in
// reads as the dead end it is before it is ticked rather than after.
const reachOf = (id: string): string => {
    const names = namesOf([id]);
    return names.length === 0 ? t(`sandbox.sandboxAccess.areaNoAssistant`) : names.join(`, `);
};

const toggle = (id: string, on: boolean): void => {
    const next = on ? [...new Set([...held.value, id])] : held.value.filter((area) => area !== id);
    emit(`change`, next);
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <p v-if="areas.length === 0" class="text-sm text-muted">
            {{ t(`sandbox.sandboxAccess.noAreasToGrant`) }}
            <RouterLink to="/sandbox/areas" class="text-content underline">{{ t(`sandbox.sandboxAccess.nameOne`) }}</RouterLink>
        </p>
        <template v-else>
            <SegmentedControl
                v-if="!needsOne"
                :model-value="scope"
                :options="SCOPES"
                :class="{ 'pointer-events-none opacity-60': disabled }"
                @update:model-value="pickScope"
            />
            <!-- Ticks on rows, not chips: each area is read with its folders, and for a guest with who works there. -->
            <div v-if="scope === `some`" class="-mx-2.5 flex flex-col gap-0.5" role="group" :aria-label="t(`sandbox.sandboxAccess.whereSection`)">
                <label
                    v-for="area in areas"
                    :key="area.id"
                    class="ui-row-select flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2"
                    :class="{ 'ui-row-select-on': held.includes(area.id), 'pointer-events-none opacity-60': disabled }"
                >
                    <Checkbox
                        :model-value="held.includes(area.id)"
                        binary
                        size="small"
                        class="mt-0.5"
                        :disabled="disabled"
                        @update:model-value="(on: unknown) => toggle(area.id, on === true)"
                    />
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="text-sm font-medium text-content">{{ area.label ?? area.id }}</span>
                        <span class="truncate font-mono text-2xs text-subtle">{{ area.folders.join(`, `) }}</span>
                    </span>
                    <span v-if="role === `guest`" class="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
                        <Icon name="comments" class="text-2xs" />{{ reachOf(area.id) }}
                    </span>
                </label>
            </div>

            <!-- What the pick hands over, in assistants. Guidance stays quiet until a pick is actually wrong: an empty pick
                 on a tier that needs one is the next step, not a mistake. -->
            <p v-if="nobodyAnywhere" class="text-xs text-muted">
                {{ t(`sandbox.sandboxAccess.guestHasNobodyAnywhere`) }}
                <RouterLink to="/sandbox/personas" class="text-content underline">{{ t(`sandbox.sandboxAccess.giveAssistantFolder`) }}</RouterLink>
            </p>
            <p v-else-if="needsOne && held.length === 0" class="text-xs text-muted">{{
                role === `guest` ? t(`sandbox.sandboxAccess.guestNeedsArea`) : t(`sandbox.sandboxAccess.writerNeedsArea`)
            }}</p>
            <p v-else-if="strandsDesk" class="ui-field-error">{{ t(`sandbox.sandboxAccess.noAssistantWorksHere`) }}</p>
            <p v-else-if="scope === `some` && held.length === 0" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.pickAnArea`) }}</p>
            <p v-else-if="picked === undefined" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.noAreaMeansWhole`) }}</p>
            <p v-else-if="reached.length === 0" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.fenceHoldsNoAssistant`) }}</p>
            <p v-else class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.fenceHoldsAssistants`, { names: reached.join(`, `) }) }}</p>
        </template>
    </div>
</template>
