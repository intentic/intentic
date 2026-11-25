<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, inject, ref } from "vue";
import { cancelHarness, startHarness } from "../../../../models/conversations/accounts/computerSignIn";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import { computerHarness, computerHarnesses, harnessesListed } from "../../../../models/providers/computer/computerHarnesses";
import { ACCOUNT_NUDGE } from "../../accounts/accountNudge";
import ChatGateRow from "../../accounts/ChatGateRow.vue";
import ChatChooseModelButton from "../ChatChooseModelButton.vue";
import { useHarnessAttempt } from "./harnessAttempt";

// WHAT STANDS BETWEEN THIS CHAT AND ITS FIRST TURN ON THIS COMPUTER, above the composer, drawn as a sandbox's account gate
// is (ChatGateRow.vue, ChatAccountPanel.vue): the coding agent it would run on is not here yet, is signed out, or was
// signed in once and refused its last turn. One sentence and the presses that answer it, in the gate's own order: another
// agent where one here runs, then the one press that makes this one run (set it up, or sign it in), which a press on the
// composer's Send shakes (accountNudge.ts). Pressed, the line follows the attempt for as long as it takes, as a sandbox's
// follows a sign-in waiting in the browser, with the same Cancel; failed, it says why, with Try again. Nothing while the
// agent can run. A sandbox's other lines (the privacy shield, the trial, hosted hours) have no meaning here and are not
// drawn (ChatPaneNotices.vue).

const t = useT();
const { provider } = usePaneView();

const harness = computed(() => computerHarness(provider.value));
const blocked = computed(() => (harness.value === undefined || harness.value.standing === `ready` ? undefined : harness.value));
const named = computed(() => ({ harness: blocked.value?.label ?? `` }));
const { attempt, busy, working, pageUrl, pressLabel } = useHarnessAttempt(() => blocked.value);
const sentence = computed(() => {
    const standing = blocked.value;
    if (standing === undefined) {
        return ``;
    }
    if (!standing.asked) {
        return t(`chat.computer.harness.terminal`, named.value);
    }
    if (standing.standing === `setUp`) {
        return t(`chat.computer.harness.notSetUp`, named.value);
    }
    // An account the harness still states is a sign-in that stopped working; none at all is one never made.
    return standing.account === undefined ? t(`chat.computer.harness.signedOut`, named.value) : t(`chat.computer.harness.expired`, named.value);
});
// Another coding agent here can run: picking it is a way on that waits for nothing.
const others = computed(() => computerHarnesses.value.some((other) => other.standing === `ready` && other.id !== provider.value));
// The listing has answered and names no program at all: nothing here can run until the reader installs one.
const none = computed(() => harnessesListed.value && computerHarnesses.value.length === 0);

// Each press on a composer that cannot send shakes the way on, keyed so a second press shakes it again.
const nudge = inject(ACCOUNT_NUDGE, ref(0));
</script>

<template>
    <!-- Under way: fetched onto this computer first (minutes), then the agent's own sign-in, finished in the browser here. -->
    <ChatGateRow v-if="blocked !== undefined && busy" role="status" :icon="attempt?.phase === `waiting` ? `clock` : `spinner`" :spin="attempt?.phase !== `waiting`" tone="text-link" data-harness-strip>
        {{ working }}
        <template #actions>
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="cancelHarness(blocked.id)">{{ t(`ui.action.cancel`) }}</button>
            <a v-if="pageUrl !== undefined" :href="pageUrl" target="_blank" rel="noopener noreferrer" :class="ui.textButton({ size: `xs` }, `font-semibold`)">
                {{ t(`chat.computer.harness.openPage`) }}
            </a>
        </template>
    </ChatGateRow>

    <!-- It ended without the agent running: said once, with the way to try again or put it away. -->
    <ChatGateRow v-else-if="blocked !== undefined && attempt?.phase === `failed`" role="alert" icon="exclamation-circle" tone="text-danger" data-harness-strip>
        {{ t(`chat.computer.harness.failed`, { harness: blocked.label, reason: attempt.error }) }}
        <template #actions>
            <button type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="cancelHarness(blocked.id)">{{ t(`ui.action.dismiss`) }}</button>
            <button type="button" :class="ui.textButton({ size: `xs` }, `font-semibold`)" @click="startHarness(blocked.id)">{{ t(`ui.action.tryAgain`) }}</button>
        </template>
    </ChatGateRow>

    <!-- Not runnable yet: another agent where one runs here, and the one press that makes this one run. -->
    <ChatGateRow v-else-if="blocked !== undefined" :icon="blocked.standing === `setUp` ? `download` : `sign-in`" tone="text-subtle" wide data-harness-strip>
        {{ sentence }}
        <template #actions>
            <ChatChooseModelButton
                v-if="others"
                :key="`choose-${nudge}`"
                :label="t(`chat.chatAccountPanel.chooseAnother`)"
                :tier="blocked.asked ? `boring` : `accent`"
                :class="{ 'ui-shake': nudge > 0 && !blocked.asked }"
            />
            <!-- A program the account routes do not answer for (computerHarnesses.ts `asked`) has no sign-in a press can run. -->
            <Button
                v-if="blocked.asked"
                :key="`press-${nudge}`"
                size="small"
                tier="accent"
                :label="pressLabel"
                :class="{ 'ui-shake': nudge > 0 }"
                data-harness-press
                @click="startHarness(blocked.id)"
            >
                <template #icon><Icon :name="blocked.standing === `setUp` ? `download` : `sign-in`" /></template>
            </Button>
        </template>
    </ChatGateRow>

    <ChatGateRow v-else-if="none" icon="th-large" tone="text-subtle" wide data-harness-strip>{{ t(`chat.computer.picker.none`) }}</ChatGateRow>
</template>
