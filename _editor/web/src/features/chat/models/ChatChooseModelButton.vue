<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { requestModelPick } from "./host/hostModelPicker";
import { usePaneView } from "../panel/useChat-view";
import { useT } from "@intentic/ui/i18n";

// The model list reached from a notice rather than from the composer's own pill (account gate, trial-spent strip):
// opens the shell's picker anchored to itself, and applies the answer to this pane's conversation, same as a pick
// from the composer would. Anchored to itself, not the pill, so the panel opens where the press happened.

const t = useT();

const view = usePaneView();

// Button is a component; the ref is its instance, `$el` is the actual <button> element used as anchor.
const listButton = ref<{ $el?: unknown }>();
const chooseModel = async (): Promise<void> => {
    const anchor = listButton.value?.$el;
    if (!(anchor instanceof HTMLElement)) {
        return;
    }
    const choice = await requestModelPick({ anchor, provider: view.provider.value, model: view.model.value, harness: view.harness.value });
    if (choice === undefined) {
        return;
    }
    view.selectModel({ provider: choice.provider, value: choice.model });
    if (choice.harness !== undefined) {
        view.conversation.value.selection.apply({ kind: `selectHarness`, harness: choice.harness });
    }
    if (choice.account !== undefined) {
        view.conversation.value.selection.apply({ kind: `selectAccount`, account: choice.account });
    }
};
</script>

<template>
    <Button ref="listButton" size="small" class="shrink-0" @click="chooseModel">
        <Icon name="th-large" />{{ t(`chat.chatChooseModelButton.chooseModel`) }}
    </Button>
</template>
