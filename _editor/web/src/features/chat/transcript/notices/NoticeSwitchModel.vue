<script setup lang="ts">
import { Button, type ButtonTier } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { usePaneModelPick } from "../../../../models/conversations/accounts/paneModelPick";

/* The press under a turn a model's refusal stopped partway (a spent trial, a model no longer served): the model list,
   so the same conversation, its history and its changes, carries on with another. Nothing is resent by it: the pick
   only changes what the next message runs on. */

const { tier = `quiet` } = defineProps<{ tier?: ButtonTier }>();
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
    <Button v-if="!streaming" size="small" :tier="tier" class="shrink-0" @click="open">
        {{ t(`chat.chatPaneNotices.continueOtherModel`) }}
    </Button>
</template>
