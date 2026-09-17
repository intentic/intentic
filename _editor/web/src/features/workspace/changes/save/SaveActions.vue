<script setup lang="ts">
import { ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useVocabulary } from "../../../../core-views/vocabulary";
import { useChanges } from "../useChanges";
import { useSaveActions } from "./useSaveActions";

// The maker's two whole-tree presses, drawn in the sidebar's own icon row beside Refresh rather than in a bar along
// the panel's floor: a press that acts on everything belongs where the panel is titled, not below the list it would
// empty. Both are glyph-only, like every other press in that row, and both raise something that says what they do —
// a card for the one that throws work away, the push flow's own question for the other.

const t = useT();
const changes = useChanges();
const words = useVocabulary();
const actions = useSaveActions();
const { mobile } = useDevice();

// The row this rides is the host's; a phone's is thumb-sized, so the geometry follows the surface, not a prop.
const box = computed(() => (mobile.value ? `h-10 w-10 rounded-lg active:bg-overlay` : ``));
const glyph = computed(() => (mobile.value ? `text-base` : `text-xs`));

const savingNow = computed(() => changes.committing.value.length > 0);
// The label an icon hasn't got, in the audience's own verb: it leads both the tooltip and the screen reader's name.
const discardAll = computed(() => `${words.value.discard} ${t(`workspace.savePanel.all`)}`);
</script>

<template>
    <button
        v-if="changes.count.value > 0"
        type="button"
        :class="ui.iconButton(box, `hover:bg-danger/10 hover:text-danger`)"
        :disabled="changes.actionBusy.value || savingNow"
        @click="actions.ask('all')"
        v-tooltip.bottom="`${discardAll} · ${t(`workspace.savePanel.putsEveryFileBack`)}`"
        :aria-label="discardAll"
    >
        <Icon name="undo" :class="glyph" />
    </button>
    <button
        v-if="actions.backupRepos.value.length > 0"
        type="button"
        :class="ui.iconButton(box)"
        :disabled="actions.backingUp.value || changes.actionBusy.value"
        @click="actions.doBackUp()"
        v-tooltip.bottom="`${actions.backupLine.value} · ${t(`workspace.savePanel.sendsSavedVersionsTo`, { repo: words.repo })}`"
        :aria-label="words.push"
    >
        <Icon :name="actions.backingUp.value ? `spinner` : `cloud-upload`" :spin="actions.backingUp.value" :class="glyph" />
    </button>
</template>
