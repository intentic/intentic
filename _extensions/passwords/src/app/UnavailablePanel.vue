<!-- WHY PASSWORDS CANNOT OPEN, and its way out where the port offers one. A fix that takes a while (an update, a repair)
     draws its stages as it reaches them: what is done, what runs now and what the person does for it (a Windows prompt
     to answer), what is still to come. A person watching a disabled button for minutes cannot tell working from stuck. -->
<script setup lang="ts">
import { Button, Icon, messageOr } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { t } from "../i18n.js";
import type { StatusFix } from "./port.js";

const { reason, fix } = defineProps<{ reason: string; fix?: StatusFix | undefined }>();
const emit = defineEmits<{ retry: []; settled: [] }>();

const running = ref(false);
const error = ref<string | undefined>(undefined);
// The stage reached last, by its index in `fix.steps`; -1 before the first.
const reached = ref(-1);
// Where the last run stopped, so a failure is drawn on the stage it happened in.
const failedAt = ref<number | undefined>(undefined);

const steps = computed(() => fix?.steps ?? []);
const showSteps = computed(() => steps.value.length > 0 && (running.value || failedAt.value !== undefined));

type StepState = `done` | `now` | `failed` | `later`;
const stateOf = (index: number): StepState => {
    if (failedAt.value === index) {
        return `failed`;
    }
    if (index < reached.value) {
        return `done`;
    }
    return index === reached.value && running.value ? `now` : `later`;
};

const run = async (): Promise<void> => {
    if (fix === undefined || running.value) {
        return;
    }
    running.value = true;
    error.value = undefined;
    failedAt.value = undefined;
    reached.value = -1;
    try {
        await fix.run((id) => {
            const index = steps.value.findIndex((step) => step.id === id);
            // A stage this fix does not draw (a repair skips the keyring's own yes) leaves the list where it was.
            if (index > reached.value) {
                reached.value = index;
            }
        });
        reached.value = steps.value.length;
    } catch (failure) {
        error.value = messageOr(failure, t(`app.error.act`));
        failedAt.value = steps.value.length > 0 ? Math.max(reached.value, 0) : undefined;
    } finally {
        running.value = false;
        emit(`settled`);
    }
};
</script>

<template>
    <div class="m-auto flex w-full max-w-md flex-col items-center gap-3 px-6 text-center">
        <Icon name="key" class="text-4xl text-subtle" />
        <p class="text-base font-semibold text-content">{{ running ? (fix?.doing ?? fix?.label) : t(`app.unavailable.title`) }}</p>
        <p v-if="running && showSteps" class="text-sm text-muted">{{ t(`app.unavailable.takesAWhile`) }}</p>
        <p v-else class="text-sm text-muted">{{ reason }}</p>

        <ol v-if="showSteps" class="mt-1 flex w-full flex-col gap-2.5 rounded-xl border border-line-subtle bg-card px-4 py-3 text-left" :aria-label="fix?.doing ?? fix?.label">
            <li
                v-for="(step, index) in steps"
                :key="step.id"
                class="flex items-start gap-2.5"
                :aria-current="stateOf(index) === `now` ? `step` : undefined"
            >
                <span class="mt-0.5 flex size-4 shrink-0 items-center justify-center text-sm" aria-hidden="true">
                    <Icon v-if="stateOf(index) === `done`" name="check-circle" class="text-success" />
                    <Icon v-else-if="stateOf(index) === `now`" name="spinner" spin class="text-info" />
                    <Icon v-else-if="stateOf(index) === `failed`" name="exclamation-circle" class="text-danger" />
                    <span v-else class="size-2 rounded-full bg-line" />
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                    <span
                        class="text-sm"
                        :class="{
                            'text-content': stateOf(index) === `now` || stateOf(index) === `failed`,
                            'text-muted': stateOf(index) === `done`,
                            'text-subtle': stateOf(index) === `later`,
                        }"
                    >{{ step.label }}</span>
                    <span v-if="step.hint && stateOf(index) === `now`" class="text-xs text-info" role="status">{{ step.hint }}</span>
                </span>
            </li>
        </ol>

        <p v-if="error" class="text-sm text-danger" role="alert">{{ error }}</p>
        <template v-if="!running">
            <Button v-if="fix" :label="error ? t(`app.unavailable.tryAgain`) : fix.label" @click="run()" />
            <Button v-else tier="boring" :label="t(`app.retry`)" @click="emit(`retry`)" />
        </template>
        <Button v-else-if="!showSteps" :label="fix?.label ?? ``" disabled />
    </div>
</template>
