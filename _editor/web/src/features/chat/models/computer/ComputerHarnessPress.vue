<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { cancelHarness, harnessAttempts, startHarness } from "../../../../models/conversations/accounts/computerSignIn";
import type { ComputerHarness } from "../../../../models/providers/computer/computerHarnesses";

// THE ONE PRESS A CODING AGENT OF THIS COMPUTER NEEDS BEFORE IT CAN RUN (computerSignIn.ts): set it up, or sign it in.
// Pressed, it says what is happening for as long as it takes (a fetch runs for minutes), that the sign-in continues in
// the browser on this computer, with the page's address where the harness printed one, and how to stop waiting. Drawn
// the same above the composer and in the picker, and one attempt per harness whichever of the two was pressed.

const props = defineProps<{ readonly harness: ComputerHarness }>();

const t = useT();
const attempt = computed(() => harnessAttempts.value[props.harness.id]);
const named = computed(() => ({ harness: props.harness.label }));
const pressLabel = computed(() => (props.harness.standing === `setUp` ? t(`chat.computer.harness.setUp`, named.value) : t(`chat.computer.harness.signIn`, named.value)));
const working = computed(() => {
    if (attempt.value?.phase === `waiting`) {
        return t(`chat.computer.harness.inBrowser`, named.value);
    }
    return props.harness.standing === `setUp` ? t(`chat.computer.harness.settingUp`, named.value) : t(`chat.computer.harness.starting`, named.value);
});
const busy = computed(() => attempt.value?.phase === `starting` || attempt.value?.phase === `waiting`);
const pageUrl = computed(() => (attempt.value?.phase === `waiting` && attempt.value.url !== `` ? attempt.value.url : undefined));
</script>

<template>
    <div class="flex min-w-0 flex-col gap-1.5" data-harness-press>
        <!-- A program the account routes do not answer for (providers/computer/computerHarnesses.ts `asked`) has no sign-in a press can run. -->
        <p v-if="!harness.asked" class="text-2xs text-muted">{{ t(`chat.computer.harness.terminal`, named) }}</p>
        <template v-else-if="busy">
            <p class="flex items-baseline gap-2 text-2xs text-muted" role="status">
                <Icon name="spinner" spin class="shrink-0" />
                <span class="min-w-0">{{ working }}</span>
            </p>
            <div class="flex flex-wrap items-center gap-3 pl-5">
                <a v-if="pageUrl !== undefined" :href="pageUrl" target="_blank" rel="noopener noreferrer" class="text-2xs text-link hover:underline">
                    {{ t(`chat.computer.harness.openPage`) }}
                </a>
                <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="cancelHarness(harness.id)" />
            </div>
        </template>
        <template v-else>
            <p v-if="attempt?.phase === `failed`" class="text-2xs text-danger" role="alert">
                {{ t(`chat.computer.harness.failed`, { harness: harness.label, reason: attempt.error }) }}
            </p>
            <Button class="self-start" size="small" tier="accent" :label="pressLabel" @click="startHarness(harness.id)">
                <template #icon><Icon :name="harness.standing === `setUp` ? `download` : `sign-in`" /></template>
            </Button>
        </template>
    </div>
</template>
