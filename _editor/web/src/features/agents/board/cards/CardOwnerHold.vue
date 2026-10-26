<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { ownerHoldLine, type OwnerHold } from "../../../../models/conversations/review/ownerHold";
import { useVocabulary } from "../../../../workbench/views/vocabulary";
import { useAudience } from "../../../../app/useAudience";

// A refused land only the owner can clear, said in the card's decision seat: what of theirs is in the way, named, and,
// for a deletion, both answers as presses. Nothing on the card can commit an edit (only its owner can judge one), so an
// edit stays a sentence and the card moves on by itself once it is committed; a deletion is the case the card CAN carry
// out, either way, and the one a sentence over "your edits" left the owner hunting for an edit that did not exist
// (deft-lynx-0y1h, 2026-10-26).

const t = useT();
const words = useVocabulary();
const { maker } = useAudience();

const props = defineProps<{
    // Undefined until the owner's own Changes are read: the general sentence stands in.
    owner: OwnerHold | undefined;
    // workspaceOverlap's sentence, for a hold too large to name file by file.
    overlap: string | undefined;
    // The Sandbox pages that wrote every held file, when they did.
    settingsPages: string | undefined;
    // Keep deleted sends the agent a turn, which only this sandbox's own agent can take.
    local: boolean;
    busy: boolean;
}>();

const emit = defineEmits<{ keepDeleted: [owner: OwnerHold]; restoreDeleted: [owner: OwnerHold] }>();

const deleted = computed(() => (props.owner?.kind === `deleted` && props.settingsPages === undefined ? props.owner : undefined));

const line = computed(() => {
    if (props.overlap !== undefined) {
        return props.overlap;
    }
    if (props.settingsPages !== undefined) {
        return t(`agents.agentCard.settingsNotSaved`, { pages: props.settingsPages });
    }
    const owner = props.owner;
    if (owner === undefined) {
        return words.value.clearYoursHint;
    }
    // An edit is named in git's words only to a developer: the plain-words reader keeps their own sentence.
    return owner.kind === `edited` && maker.value ? words.value.clearYoursHint : ownerHoldLine(owner);
});
// The whole path behind a single file's name.
const path = computed(() => (props.overlap === undefined && props.settingsPages === undefined ? props.owner?.only : undefined));
</script>

<template>
    <div class="flex min-w-0 flex-col gap-1">
        <p class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
            <Icon :name="deleted === undefined ? `file-edit` : `trash`" class="shrink-0 text-2xs text-warning" /><span
                class="min-w-0 break-words"
                v-tooltip.top="path"
                >{{ line }}</span
            >
        </p>
        <!-- Keeping it gone leads: deleting it was the owner's own last word on the file. -->
        <div v-if="deleted !== undefined" class="flex flex-wrap items-center gap-1.5">
            <Button
                v-if="local"
                size="small"
                :disabled="busy"
                class="whitespace-nowrap"
                v-tooltip.bottom="{ title: t(`agents.agentCard.keepDeletedTitle`), note: t(`agents.agentCard.keepDeletedNote`) }"
                @click.stop="emit('keepDeleted', deleted)"
            >
                <Icon name="trash" />{{ t(`agents.agentCard.keepDeleted`) }}
            </Button>
            <Button
                size="small"
                tier="quiet"
                :disabled="busy"
                class="whitespace-nowrap"
                v-tooltip.bottom="{
                    title: t(`agents.agentCard.restoreAndLandTitle`),
                    note: t(`agents.agentCard.restoreAndLandNote`),
                }"
                @click.stop="emit('restoreDeleted', deleted)"
            >
                <Icon name="undo" />{{ t(`agents.agentCard.restoreAndLand`) }}
            </Button>
        </div>
    </div>
</template>
