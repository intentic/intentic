<script setup lang="ts">
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref, watch } from "vue";

// A JavaScript dialog the page has open, held by the daemon until someone answers, here or by the agent, whichever
// first; centred like the browser's own would be. The prompt's text starts as what the page prefilled, and follows the
// dialog rather than the pane, so a second prompt doesn't inherit the first's.

const { dialog } = defineProps<{ dialog: NonNullable<BrowserSession[`dialog`]> }>();
const emit = defineEmits<{ answer: [accept: boolean, text?: string] }>();
const t = useT();

const text = ref(``);
watch(
    () => dialog,
    (open) => {
        text.value = open.defaultValue ?? ``;
    },
    { immediate: true },
);
const answer = (accept: boolean): void => emit(`answer`, accept, dialog.kind === `prompt` && accept ? text.value : undefined);
</script>

<template>
    <div class="absolute inset-0 z-20 flex items-start justify-center bg-canvas/40 p-6">
        <div class="flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-card p-4 shadow-lg">
            <div class="text-xs font-medium text-content">
                {{ dialog.kind === `beforeunload` ? t(`browsers.browsers.leavePage`) : t(`browsers.browsers.pageSays`) }}
            </div>
            <div v-if="dialog.kind !== `beforeunload`" class="whitespace-pre-wrap break-words text-xs text-content">
                {{ dialog.message }}
            </div>
            <input
                v-if="dialog.kind === `prompt`"
                v-model="text"
                type="text"
                class="ui-field-box ui-field-sm w-full"
                @keydown.enter.prevent="answer(true)"
                @keydown.esc.prevent="answer(false)"
            />
            <div class="flex justify-end gap-2">
                <Button v-if="dialog.kind !== `alert`" size="small" tier="quiet" @click="answer(false)">
                    {{ dialog.kind === `beforeunload` ? t(`browsers.browsers.stay`) : t(`ui.action.cancel`) }}
                </Button>
                <Button tier="accent" size="small" @click="answer(true)">
                    {{ dialog.kind === `beforeunload` ? t(`ui.action.leave`) : t(`browsers.browsers.ok`) }}
                </Button>
            </div>
        </div>
    </div>
</template>
