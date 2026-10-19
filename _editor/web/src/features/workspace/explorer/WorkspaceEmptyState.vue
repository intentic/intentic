<!-- Shown in the viewer pane when the workspace holds no files at all; with files, that pane is the home. -->
<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import { useAudience } from "../../../app/useAudience";
import AudienceAsk from "./AudienceAsk.vue";
import BringProjectChoices from "./BringProjectChoices.vue";
import { useT } from "@intentic/ui/i18n";

// An empty workspace spells out every way to get code in. Emptiness is read off the tree by the view that owns it
// (EditorPane's `empty`): this pane never fetches, and never renders once there is something to draw.
const t = useT();

const emit = defineEmits<{ pick: [] }>();

// Asked here, where a new arrival first stands, until answered once in this browser.
const { chosen: audienceChosen } = useAudience();
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <!-- The newcomer's screen only, and only until answered; Settings holds the question afterwards. -->
        <AudienceAsk v-if="!audienceChosen" />

        <!-- Every way in, most common first. -->
        <div class="flex max-w-md flex-col gap-1">
            <p class="inline-flex items-center justify-center gap-1.5 text-base font-semibold text-content">
                {{
                    t(`workspace.workspaceEmptyState.getCodeIn`)
                }}<!-- The getting-started mark for bringing work in: this page is where that step is done. --><TourMark
                    step="work"
                    place="workspace"
                    :priority="3"
                    side="bottom"
                />
            </p>
            <p class="text-xs text-muted">
                {{ t(`workspace.workspaceEmptyState.workspaceAgentsReadEdit`) }}
            </p>
        </div>

        <BringProjectChoices class="max-w-md" @pick="emit(`pick`)" />

        <span class="inline-flex items-center gap-1.5 rounded-full bg-subtle/10 px-2.5 py-1 text-2xs font-medium text-subtle">
            <Icon name="lock" class="text-[0.7rem]" />
            {{ t(`workspace.workspaceEmptyState.filesStayOnSandbox`) }}
        </span>
    </div>
</template>
