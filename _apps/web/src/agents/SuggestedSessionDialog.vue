<script setup lang="ts">
import Dialog from "primevue/dialog";
import { dismissSuggestion, pendingSuggestion, startSuggestedSession } from "../composables/agents/sessionSuggestion";
import SuggestedSessionBox from "./SuggestedSessionBox.vue";

/* THE ONE PLACE A SUGGESTED SESSION SURFACES. Mounted app-wide (App.vue) and driven entirely by module state,
 * so raising one is a function call from anywhere — `suggestSession({...})` — with no wiring at the call site
 * and no dialog of its own to build. Today the pre-push check raises it; the shape is general because the
 * situation is: the app knows a specific piece of agent work is worth doing, and the user owns the decision.
 *
 * IT PROPOSES, IT DOES NOT ACT. Dismissing is free and leaves nothing behind (the draft was never a tab), and
 * every part of the proposal is editable before it runs — the text, the model, the effort. That is the whole
 * difference from the auto-fix this replaced, which spent a frontier model on a prompt nobody read.
 *
 * The evidence sits above the composer and scrolls on its own: it is what the user is judging, and it must not
 * push the box they are judging it with off the bottom of the dialog. */
</script>

<template>
    <Dialog
        :visible="pendingSuggestion !== undefined"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '38rem' }"
        :header="pendingSuggestion?.suggestion.title ?? ''"
        @update:visible="dismissSuggestion"
    >
        <template v-if="pendingSuggestion">
            <p class="mb-2 break-words text-xs text-muted">{{ pendingSuggestion.suggestion.why }}</p>

            <pre
                v-if="pendingSuggestion.suggestion.evidence"
                class="scrollbar-thin mb-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-overlay px-2.5 py-2 font-mono text-2xs leading-relaxed text-muted"
                >{{ pendingSuggestion.suggestion.evidence }}</pre
            >

            <SuggestedSessionBox
                :conversation="pendingSuggestion.draft"
                :action="pendingSuggestion.suggestion.action"
                @start="startSuggestedSession"
            />
        </template>
    </Dialog>
</template>
