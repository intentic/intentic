<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { usePaneModelPick } from "../../../../models/conversations/accounts/paneModelPick";

/* The press under a turn a model's refusal stopped partway (a spent trial, a model no longer served): the model list,
   so the same conversation, its history and its changes, carries on with another. Nothing is resent by it: the pick
   only changes what the next message runs on. */

const t = useT();
const { streaming } = usePaneView();
const pick = usePaneModelPick();
const open = async (event: MouseEvent): Promise<void> => {
    if (event.currentTarget instanceof HTMLElement) {
        await pick(event.currentTarget);
    }
};
</script>

<template>
    <button
        v-if="!streaming"
        type="button"
        class="touch-target shrink-0 font-medium text-link hover:underline"
        @click="open"
    >
        {{ t(`chat.chatPaneNotices.continueOtherModel`) }}
    </button>
</template>
