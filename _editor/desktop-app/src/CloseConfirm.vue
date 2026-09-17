<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ui, vAction } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { onMounted, onUnmounted, ref } from "vue";
import { closeWorkspace, type CloseAction } from "./desktop";
import { dragWindow } from "./dragWindow";
import { useFitToContent } from "./fitWindow";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* WHAT THE × DOES: asked before it does it. */
const remember = ref(false);
const keep = ref<HTMLButtonElement | undefined>(undefined);
const content = ref<HTMLElement | undefined>(undefined);
useFitToContent(content);

// Reads the webview's own user agent rather than a round trip, so the window isn't delayed by a shell-out.
const onWindows = navigator.userAgent.includes(`Windows`);

const choose = (action: CloseAction): Promise<void> => closeWorkspace(action, remember.value);

// Escape or the dialog's own × means "I didn't mean to close it": nothing is remembered, and this window simply
// closes.
const cancel = (): Promise<void> => getCurrentWindow().close();
const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        void cancel();
    }
};

onMounted(() => {
    window.addEventListener(`keydown`, onKey);
    // Focused so Return picks the recoverable answer (stay in tray), not quitting.
    keep.value?.focus();
});
onUnmounted(() => window.removeEventListener(`keydown`, onKey));
</script>

<template>
    <div class="h-dvh overflow-auto bg-canvas text-content">
        <div ref="content" class="flex flex-col gap-4 p-5">
            <!-- The header is the title bar: every press on it that isn't the × moves the window (dragWindow.ts). -->
            <header class="flex items-start gap-3 select-none" @mousedown="dragWindow">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 class="text-base font-semibold">{{ t(`desktop.closeConfirm.closeIntentic`) }}</h1>
                    <p class="text-2xs text-muted">{{ t(`desktop.closeConfirm.sandboxesKeepRunningEither`) }}</p>
                </div>
                <button type="button" :class="ui.iconButton(`-my-0.5 h-7 w-7`)" :aria-label="t(`ui.action.cancel`)" @click="cancel">
                    <Icon name="times" />
                </button>
            </header>

            <!-- Two answers as two things to press, not a radio group and a confirm button. -->
            <div class="flex flex-col gap-2">
                <button
                    ref="keep"
                    type="button"
                    class="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay focus-visible:border-primary-500 focus-visible:outline-none"
                    v-action="() => choose(`tray`)"
                >
                    <Icon name="compress" class="mt-0.5 shrink-0 text-primary-400" />
                    <span class="min-w-0 flex-1">
                        <span class="block text-xs font-medium">{{ t(`desktop.closeConfirm.keepIntenticInTray`) }}</span>
                        <span class="block text-2xs text-muted">{{ t(`desktop.closeConfirm.keepsRunningInBackground`) }}</span>
                        <span v-if="onWindows" class="mt-1 block text-2xs text-subtle">
                            {{ t(`desktop.closeConfirm.lookIconByClock`) }}
                        </span>
                    </span>
                </button>

                <button
                    type="button"
                    class="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay focus-visible:border-primary-500 focus-visible:outline-none"
                    v-action="() => choose(`quit`)"
                >
                    <Icon name="sign-out" class="mt-0.5 shrink-0 text-muted" />
                    <span class="min-w-0 flex-1">
                        <span class="block text-xs font-medium">{{ t(`desktop.closeConfirm.quitIntentic`) }}</span>
                        <span class="block text-2xs text-muted">{{ t(`desktop.closeConfirm.closesCompletelyStartAgain`) }}</span>
                    </span>
                </button>
            </div>

            <!-- The one control that retires this dialog for good, which is what makes asking at all defensible. -->
            <label class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                <Checkbox v-model="remember" :binary="true" />
                <span>{{ t(`desktop.closeConfirm.alwaysDoDontAsk`) }}</span>
            </label>
        </div>
    </div>
</template>
