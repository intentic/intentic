<script setup lang="ts">
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { computerHarness, computerHarnesses } from "../../../../models/providers/computer/computerHarnesses";
import { advertisedLoops } from "../../../../models/providers/offeredLoops";
import ComputerHarnessPress from "./ComputerHarnessPress.vue";

// WHAT STANDS BETWEEN THIS CHAT AND ITS FIRST TURN ON THIS COMPUTER, above the composer: the coding agent it would run
// on is not here yet, is signed out, or was signed in once and refused its last turn. One sentence and the one press
// that answers it (ComputerHarnessPress); nothing while the agent can run. A sandbox's strips (accounts to connect, the
// trial, the privacy shield, hosted hours) have no meaning here and are not drawn (ChatPaneNotices.vue).

const t = useT();
const { provider } = usePaneView();

const harness = computed(() => computerHarness(provider.value));
const blocked = computed(() => (harness.value === undefined || harness.value.standing === `ready` ? undefined : harness.value));
const sentence = computed(() => {
    const standing = blocked.value;
    if (standing === undefined) {
        return undefined;
    }
    const named = { harness: standing.label };
    if (standing.standing === `setUp`) {
        return t(`chat.computer.harness.notSetUp`, named);
    }
    // An account the harness still states is a sign-in that stopped working; none at all is one never made.
    return standing.account === undefined ? t(`chat.computer.harness.signedOut`, named) : t(`chat.computer.harness.expired`, named);
});
// The listing has answered and names no program at all: nothing here can run until the reader installs one.
const none = computed(() => advertisedLoops.value !== undefined && computerHarnesses.value.length === 0);
</script>

<template>
    <Notice v-if="blocked !== undefined" tone="warning" size="sm" data-harness-strip>
        <div class="flex min-w-0 flex-col gap-2">
            <span>{{ sentence }}</span>
            <ComputerHarnessPress :harness="blocked" />
        </div>
    </Notice>
    <Notice v-else-if="none" tone="warning" size="sm">{{ t(`chat.computer.picker.none`) }}</Notice>
</template>
