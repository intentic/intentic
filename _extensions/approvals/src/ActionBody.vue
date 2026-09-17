<!-- Body of an action awaiting approval: `summary` (headline), `details` (Markdown), and the executing turn's own `instructions`, folded. -->
<script setup lang="ts">
import type { ActionApprovalSummary } from "@intentic/sandbox-contract";
import { ui, Code, Markdown } from "@intentic/extension-ui";
import { ref } from "vue";
import { t } from "./i18n.js";

const { action, tone = `full` } = defineProps<{
    action: ActionApprovalSummary;
    /** `full` where a decision is owed; `quiet` for the sections that are only being kept an eye on. */
    tone?: `full` | `quiet`;
}>();

const showInstructions = ref(false);
</script>

<template>
    <div :class="tone === `full` ? `max-w-read` : `max-w-read-lg`">
        <!-- Quiet sections show only their summary because no action remains. -->
        <template v-if="tone === `quiet`">
            <p class="truncate text-sm font-medium text-content">{{ action.summary }}</p>
        </template>

        <template v-else>
            <p class="wrap-break-word text-base font-semibold leading-snug text-content">{{ action.summary }}</p>
            <div v-if="action.details" class="mt-2">
                <Markdown :source="action.details" style="--prose-measure: 72ch" />
            </div>
            <button
                type="button"
                :class="ui.linkButton(`mt-2 gap-1 text-2xs text-muted hover:text-content`)"
                :aria-expanded="showInstructions"
                @click="showInstructions = !showInstructions"
            >
                {{ showInstructions ? t(`actionBody.hideWhatAgentTold`) : t(`actionBody.whatAgentTold`) }}
                <Icon :name="showInstructions ? `chevron-up` : `chevron-down`" />
            </button>
            <Code v-if="showInstructions" :code="action.instructions" class="mt-1" />
        </template>
    </div>
</template>
