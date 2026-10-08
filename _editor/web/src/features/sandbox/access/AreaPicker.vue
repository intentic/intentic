<script setup lang="ts">
import type { GrantedRole } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useAreas } from "../areas/useAreas";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// Which parts of the workspace ONE person reaches, read as a sentence that finishes the role picked beside it:
// "Sees — Whole workspace", "Talks to assistants in — Support desk". The lead changes with the tier, so the line
// reads as this grant's own scope rather than a setting for everybody, and the chips are picks, not switches: a
// switch reads as something that is on for the whole sandbox.
// The fence is also the only thing deciding which assistants they may talk to, so the line under the chips names
// them: this is the one control whose consequence is not readable off the control itself.

const t = useT();

// The tier decides what this picker owes: a writer and a guest cannot be granted unfenced, and a guest's fence has to
// reach an assistant, since that is the whole of what a guest reaches.
const { picked, role, disabled = false } = defineProps<{ picked: readonly string[] | undefined; role: GrantedRole; disabled?: boolean }>();
// `undefined` is the whole workspace; a list, even empty, is the grant deciding.
const emit = defineEmits<{ change: [areas: string[] | undefined] }>();

const { areas } = useAreas();
const { namesOf } = usePersonaReach();

const held = computed<readonly string[]>(() => picked ?? []);
const reached = computed<string[]>(() => namesOf(picked));
const needsOne = computed(() => role === `writer` || role === `guest`);
// A guest reaches its assistants and nothing else, so a fence that holds none is a grant with nothing behind it.
const strandsDesk = computed(() => role === `guest` && held.value.length > 0 && reached.value.length === 0);

// The verb that finishes the role's sentence. Maintainer never gets here (that tier cannot be fenced), so it shares
// the collaborator's words rather than owning a message nothing would draw.
const LEAD: Record<GrantedRole, () => string> = {
    viewer: () => t(`sandbox.sandboxAccess.areaLeadViewer`),
    collaborator: () => t(`sandbox.sandboxAccess.areaLeadCollaborator`),
    writer: () => t(`sandbox.sandboxAccess.areaLeadWriter`),
    guest: () => t(`sandbox.sandboxAccess.areaLeadGuest`),
    maintainer: () => t(`sandbox.sandboxAccess.areaLeadCollaborator`),
};
const lead = computed(() => LEAD[role]());

// Who each area hands a guest, on the chip itself: for that tier the assistants ARE the access, so an area nobody
// works in reads as the dead end it is before it is picked rather than after.
const reachOf = (id: string): string => {
    const names = namesOf([id]);
    return names.length === 0 ? t(`sandbox.sandboxAccess.areaNoAssistant`) : names.join(`, `);
};
// Every area a dead end for a guest: said once, up front, instead of letting the owner find it chip by chip.
const nobodyAnywhere = computed(() => role === `guest` && areas.value.every((area) => namesOf([area.id]).length === 0));

const toggle = (id: string): void => {
    const next = held.value.includes(id) ? held.value.filter((area) => area !== id) : [...new Set([...held.value, id])];
    // Picking the last one off gives the workspace back rather than fencing them to nothing: nobody presses a chip
    // meaning to end up seeing no files at all, and "no fence" is the state this picker started in.
    emit(`change`, next.length === 0 ? undefined : next);
};
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <p v-if="areas.length === 0" class="text-xs text-subtle">
            {{ t(`sandbox.sandboxAccess.noAreasToGrant`) }}
            <RouterLink to="/sandbox/areas" class="underline">{{ t(`sandbox.sandboxAccess.nameOne`) }}</RouterLink>
        </p>
        <template v-else>
            <div role="group" :aria-label="lead" class="flex flex-wrap items-center gap-1.5">
                <span class="mr-0.5 text-xs text-subtle">{{ lead }}</span>
                <!-- The unfenced answer as a pick of its own, where a tier may have it: "nothing on" read as "nothing
                     granted", which is the opposite of what it means. -->
                <button
                    v-if="!needsOne"
                    type="button"
                    :class="ui.chip({ on: picked === undefined })"
                    :aria-pressed="picked === undefined"
                    :disabled="disabled"
                    @click="emit(`change`, undefined)"
                >
                    <Icon :name="picked === undefined ? `check` : `globe`" class="text-2xs" />
                    {{ t(`sandbox.sandboxAccess.wholeWorkspace`) }}
                </button>
                <button
                    v-for="area in areas"
                    :key="area.id"
                    v-tooltip.top="{ title: area.folders.join(`, `), note: area.brief }"
                    type="button"
                    :class="ui.chip({ on: held.includes(area.id) })"
                    :aria-pressed="held.includes(area.id)"
                    :disabled="disabled"
                    @click="toggle(area.id)"
                >
                    <Icon v-if="held.includes(area.id)" name="check" class="text-2xs" />
                    {{ area.label ?? area.id }}
                    <!-- The guest tier's own mark, not a separator: assistant labels carry their own middle dots. -->
                    <span v-if="role === `guest`" class="inline-flex items-center gap-1 text-subtle">
                        <Icon name="comments" class="text-2xs" />{{ reachOf(area.id) }}
                    </span>
                </button>
            </div>

            <!-- What the pick above hands over, in assistants. Guidance stays quiet until a pick is actually wrong: an
                 empty pick on a tier that needs one is the next step, not a mistake. -->
            <span v-if="nobodyAnywhere" class="text-2xs text-subtle">
                {{ t(`sandbox.sandboxAccess.guestHasNobodyAnywhere`) }}
                <RouterLink to="/sandbox/personas" class="underline">{{ t(`sandbox.sandboxAccess.giveAssistantFolder`) }}</RouterLink>
            </span>
            <span v-else-if="needsOne && held.length === 0" class="text-2xs text-subtle">{{
                role === `guest` ? t(`sandbox.sandboxAccess.guestNeedsArea`) : t(`sandbox.sandboxAccess.writerNeedsArea`)
            }}</span>
            <span v-else-if="strandsDesk" class="ui-field-error">{{ t(`sandbox.sandboxAccess.noAssistantWorksHere`) }}</span>
            <span v-else-if="picked === undefined" class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.noAreaMeansWhole`) }}</span>
            <span v-else-if="reached.length === 0" class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.fenceHoldsNoAssistant`) }}</span>
            <span v-else class="text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.fenceHoldsAssistants`, { names: reached.join(`, `) }) }}</span>
        </template>
    </div>
</template>
