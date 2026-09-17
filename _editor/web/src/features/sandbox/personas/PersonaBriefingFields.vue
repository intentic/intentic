<script setup lang="ts">
import { type TurnBriefingNoteId, TURN_BRIEFING_FIXTURES, TURN_BRIEFING_NOTES } from "@intentic/sandbox-contract";
import { ui, Icon } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useT } from "@intentic/ui/i18n";

// What the sandbox says before the user does, as a card's own decision. Rows are named with the exact titles the
// chat's "Sent with your message" fold shows, so switching one off means switching off the line you just read there.
// The draft is the parent's, mutated in place, like <PersonaPowersFields>.

const t = useT();

const { omitted } = defineProps<{
    /** Note ids this card drops; everything not listed is sent. Mutated in place. */
    omitted: TurnBriefingNoteId[];
}>();

const sends = (id: TurnBriefingNoteId): boolean => !omitted.includes(id);
const setSends = (id: TurnBriefingNoteId, on: boolean): void => {
    const at = omitted.indexOf(id);
    if (on && at !== -1) {
        omitted.splice(at, 1);
        return;
    }
    if (!on && at === -1) {
        omitted.push(id);
    }
};

// Counted, not listed: the heading says how far this card has been trimmed without repeating the rows under it.
const dropped = computed(() => TURN_BRIEFING_NOTES.filter((note) => omitted.includes(note.id)).length);

// Folded, since it is an answer to "is that the whole list?" rather than something to act on.
const showFixtures = ref(false);
</script>

<template>
    <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-0.5">
            <span :class="ui.sectionLabel()">{{ t(`sandbox.personaBriefingFields.sentEveryMessage`) }}</span>
            <span class="text-xs text-subtle">
                {{ t(`sandbox.personaBriefingFields.sandboxPutsInFront`) }}
            </span>
        </div>

        <label v-for="note in TURN_BRIEFING_NOTES" :key="note.id" class="flex flex-col gap-0.5">
            <span class="flex items-center gap-2">
                <span class="min-w-0 flex-1 text-sm text-content">{{ note.label }}</span>
                <ToggleSwitch :model-value="sends(note.id)" @update:model-value="(on: boolean) => setSends(note.id, on as boolean)" />
            </span>
            <!-- When it rides while it is on; what the turn loses once it is off. -->
            <span v-if="sends(note.id)" class="text-xs text-subtle">{{ note.when }}</span>
            <span v-else class="text-xs text-warning">{{ note.cost }}</span>
        </label>

        <div class="flex flex-col gap-1">
            <button
                type="button"
                :class="ui.linkButton('gap-1 self-start text-xs text-muted hover:text-content')"
                @click="showFixtures = !showFixtures"
            >
                <Icon :name="showFixtures ? `chevron-down` : `chevron-right`" class="text-2xs" />
                {{ TURN_BRIEFING_FIXTURES.length }} {{ t(`sandbox.personaBriefingFields.moreAlwaysSent`) }}
            </button>
            <!-- Omitted notes are named so the visible briefing list is unambiguous. -->
            <dl v-if="showFixtures" class="flex flex-col gap-1 pl-5">
                <div v-for="fixture in TURN_BRIEFING_FIXTURES" :key="fixture.label" class="flex flex-col">
                    <dt class="text-xs text-muted">{{ fixture.label }}</dt>
                    <dd class="text-xs text-subtle">{{ fixture.why }}</dd>
                </div>
            </dl>
        </div>

        <p v-if="dropped > 0" class="text-xs text-subtle">
            {{ t(`sandbox.personaBriefingFields.turnedOffPersonaEvery`, { dropped, count: TURN_BRIEFING_NOTES.length }) }}
        </p>
    </div>
</template>
