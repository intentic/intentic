<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { useT } from "@intentic/ui/i18n";
import { usePaneModelPick } from "../../../models/conversations/accounts/paneModelPick";

// The model list reached from a notice rather than from the composer's own pill (account gate, trial-spent strip):
// opens the shell's picker anchored to itself, and applies the answer to this pane's conversation, same as a pick
// from the composer would. Anchored to itself, not the pill, so the panel opens where the press happened.

const t = useT();

// A notice may name the press for its own moment ("Continue with another model" on a spent trial) and make it the
// card's filled press; the account gate keeps the plain "Choose a model".
const props = defineProps<{ label?: string; tier?: `accent` }>();

const pick = usePaneModelPick();

// Button is a component; the ref is its instance, `$el` is the actual <button> element used as anchor.
const listButton = ref<{ $el?: unknown }>();
const chooseModel = async (): Promise<void> => {
    const anchor = listButton.value?.$el;
    if (anchor instanceof HTMLElement) {
        await pick(anchor);
    }
};
</script>

<template>
    <Button ref="listButton" size="small" class="shrink-0" :tier="props.tier" @click="chooseModel">
        <Icon name="th-large" />{{ props.label ?? t(`chat.chatChooseModelButton.chooseModel`) }}
    </Button>
</template>
