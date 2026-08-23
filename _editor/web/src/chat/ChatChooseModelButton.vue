<script setup lang="ts">
import { Button } from "@intentic/ui";
import { ref } from "vue";
import { requestModelPick } from "../composables/chat/hostModelPicker";
import { usePaneView } from "../composables/chat/useChat";

/* THE DOOR TO THE MODEL LIST, drawn by whichever strip has taken the composer's place.
 *
 * It is its own component because two different strips need it and they are mutually exclusive: the account
 * gate when this sandbox has nothing connected, and the trial strip once today's allowance is spent. Both are
 * standing in for a composer that is not rendered, so both need the same escape: the list, where every other
 * way to send lives, free ones included.
 *
 * IT OPENS THE SHELL'S PICKER, ANCHORED TO ITSELF. The composer's own picker hangs off the model pill, and that
 * pill does not exist while either strip is up: a desktop overlay with no anchor has nowhere to place itself.
 *
 * The answer is applied to THIS pane's conversation, which is what makes choosing a model here identical to
 * choosing one from the composer: a connected provider starts sending immediately, and a locked one points the
 * chat and leaves the handshake below. */

const view = usePaneView();

// Button is a component, so the ref hands back its instance rather than an element; `$el` is its <button>, and
// that element is what decides where the panel places itself and which window it opens in.
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
        view.selectHarness(choice.harness);
    }
    if (choice.account !== undefined) {
        view.selectAccount(choice.account);
    }
};
</script>

<template>
    <Button ref="listButton" size="small" class="shrink-0" @click="chooseModel"> <Icon name="th-large" />Choose a model </Button>
</template>
