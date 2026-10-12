<!-- The review before a bring-back: every change the sandbox holds, chosen until the reader unticks it (a change made on both sides starts unticked), and one press that copies exactly the chosen ones into the folder. -->
<script setup lang="ts">
import { Button, ChangeStatusMark, formatCount, Modal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref, watch } from "vue";
import { BRING_BACK_CAP, firstChosen, type SandboxChange } from "./bringBack";

const t = useT();

const {
    changes,
    truncated = false,
    busy = false,
    error,
} = defineProps<{
    changes: readonly SandboxChange[];
    // The app listed only the first of more changes than that.
    truncated?: boolean;
    // The copy is running: the box stays up, so the press has somewhere to show it.
    busy?: boolean;
    // Why the last bring-back failed, said where it was asked for.
    error?: string | undefined;
}>();
const open = defineModel<boolean>(`open`, { required: true });
const emit = defineEmits<{ bring: [chosen: ReadonlySet<string>] }>();

const chosen = ref<ReadonlySet<string>>(firstChosen(changes));
// Each time the review opens it starts over, on every change but those made on both sides.
watch(open, (shown) => {
    if (shown) {
        chosen.value = firstChosen(changes);
    }
});

const choose = (path: string, on: boolean): void => {
    const next = new Set(chosen.value);
    if (on) {
        next.add(path);
    } else {
        next.delete(path);
    }
    chosen.value = next;
};
const allChosen = computed(() => changes.every((change) => chosen.value.has(change.path)));
const chooseAll = (on: boolean): void => {
    chosen.value = on ? new Set(changes.map((change) => change.path)) : new Set();
};
// More than one bring-back names (bringBack.ts): refused, with the way round it said.
const tooMany = computed(() => chosen.value.size > BRING_BACK_CAP);
</script>

<template>
    <Modal v-model:open="open" size="md" :header="t(`local.bringBackReview.header`)" :description="t(`local.bringBackReview.intro`)">
        <!-- The list and what it says about itself: one column, the all-box ruled off above the files it ticks. -->
        <div class="flex flex-col gap-2">
            <div>
                <label class="flex items-center gap-2 border-b border-line pb-1.5 text-xs text-muted">
                    <Checkbox :model-value="allChosen" binary size="small" :disabled="busy" @update:model-value="chooseAll($event === true)" />
                    {{ t(`local.bringBackReview.all`, { count: changes.length }, changes.length) }}
                </label>
                <ul class="max-h-72 overflow-auto py-1">
                    <li v-for="change in changes" :key="change.path">
                        <label class="flex min-w-0 items-center gap-2 py-0.5">
                            <Checkbox
                                class="ui-checkbox-quiet"
                                :model-value="chosen.has(change.path)"
                                binary
                                size="small"
                                :disabled="busy"
                                @update:model-value="choose(change.path, $event === true)"
                            />
                            <ChangeStatusMark :status="change.kind" />
                            <!-- Cut from the left, so a deep path still ends on the file's own name. -->
                            <span class="min-w-0 truncate font-mono text-2xs text-content" dir="rtl"
                                ><bdi>{{ change.path }}</bdi></span
                            >
                            <span v-if="change.conflict === true" class="shrink-0 text-2xs text-warning">{{
                                t(`local.bringBackReview.conflict`)
                            }}</span>
                        </label>
                    </li>
                </ul>
            </div>
            <p v-if="truncated" class="text-2xs text-warning">{{ t(`local.bringBackReview.truncated`) }}</p>
            <p v-if="tooMany" class="text-2xs text-warning">
                {{ t(`local.bringBackReview.tooMany`, { max: formatCount(BRING_BACK_CAP) }) }}
            </p>
            <p v-if="error" class="text-xs text-danger">{{ error }}</p>
        </div>
        <template #footer>
            <Button tier="quiet" :label="t(`ui.action.cancel`)" @click="open = false" />
            <Button
                :label="t(`local.bringBackReview.bring`, { count: chosen.size }, chosen.size)"
                :loading="busy"
                :disabled="chosen.size === 0 || tooMany"
                @click="emit(`bring`, chosen)"
            />
        </template>
    </Modal>
</template>
