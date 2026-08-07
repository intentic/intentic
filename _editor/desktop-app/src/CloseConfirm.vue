<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import { onMounted, onUnmounted, ref } from "vue";
import { closeWorkspace, type CloseAction } from "./desktop";

/* WHAT THE × DOES — asked before it does it.
 *
 * Closing this app's window does not close the app: it steps into the tray and keeps running, which is a fine
 * deal only if the user is in on it. They were not. The window vanished and an OS message box announced, after
 * the fact, that Intentic was "still running" — a report with one button, and a native box whose icon is what
 * makes Windows play the alert chime at it. Nothing had gone wrong, and it sounded like something had.
 *
 * So: a question, before anything moves, in this app's own window (windows.rs — which is also the only way to
 * draw it without the chime). Two answers, both of them real, each saying what it costs. The lede is the fact
 * that makes the choice safe either way, and it is first because it is the thing nobody knew.
 *
 * The tray note is the whole reason the old notice existed, kept and moved to where it is useful: beside the
 * option it is about, at the moment that option is being chosen, rather than after the icon has already
 * disappeared into the overflow. Windows only — it is Windows that files new tray icons behind the arrow.
 */
const remember = ref(false);
const keep = ref<HTMLButtonElement | undefined>(undefined);

// The webview's own user agent, not a round trip: this window has to be on screen the instant the × is
// clicked, and a command that shells out to look at the machine is the one thing that could delay it.
const onWindows = navigator.userAgent.includes(`Windows`);

const choose = (action: CloseAction): Promise<void> => closeWorkspace(action, remember.value);

/* Escape and the dialog's own × mean "I did not mean to close it" — the window stays exactly as it was, and
 * nothing is remembered. Backing out is this window closing and nothing else, so there is no command for it. */
const cancel = (): Promise<void> => getCurrentWindow().close();
const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        void cancel();
    }
};

onMounted(() => {
    window.addEventListener(`keydown`, onKey);
    // Focused so Return takes the safe answer. The app staying up is recoverable in one click; quitting in the
    // middle of a setup is not, so it is never what a stray keystroke picks.
    keep.value?.focus();
});
onUnmounted(() => window.removeEventListener(`keydown`, onKey));
</script>

<template>
    <div class="flex h-dvh flex-col gap-4 overflow-auto bg-canvas p-5 text-content">
        <header class="flex flex-col gap-1">
            <h1 class="text-base font-semibold">Close Intentic?</h1>
            <p class="text-2xs text-muted">Your sandboxes keep running either way — they live in Docker, not in this window.</p>
        </header>

        <!-- Two answers as two things to press, not a radio group and a confirm button: every extra step here
             is one taken by somebody who has already said what they want by clicking the ×. -->
        <div class="flex flex-col gap-2">
            <button
                ref="keep"
                type="button"
                class="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay focus-visible:border-primary-500 focus-visible:outline-none"
                @click="choose(`tray`)"
            >
                <Icon name="compress" class="mt-0.5 shrink-0 text-primary-400" />
                <span class="min-w-0 flex-1">
                    <span class="block text-xs font-medium">Keep Intentic in the tray</span>
                    <span class="block text-2xs text-muted">Keeps running in the background — reopening is instant, still signed in.</span>
                    <span v-if="onWindows" class="mt-1 block text-2xs text-subtle">
                        Look for its icon by the clock, or behind the ^ arrow next to it.
                    </span>
                </span>
            </button>

            <button
                type="button"
                class="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-line bg-card p-3 text-left transition-colors hover:border-line-strong hover:bg-overlay focus-visible:border-primary-500 focus-visible:outline-none"
                @click="choose(`quit`)"
            >
                <Icon name="sign-out" class="mt-0.5 shrink-0 text-muted" />
                <span class="min-w-0 flex-1">
                    <span class="block text-xs font-medium">Quit Intentic</span>
                    <span class="block text-2xs text-muted">Closes it completely. Start it again whenever you need it.</span>
                </span>
            </button>
        </div>

        <!-- The one control that retires this dialog for good, which is what makes asking at all defensible. -->
        <footer class="mt-auto flex items-center gap-3">
            <label class="flex flex-1 cursor-pointer items-center gap-2 text-2xs text-muted">
                <Checkbox v-model="remember" :binary="true" />
                <span>Always do this — don't ask again</span>
            </label>
            <Button size="small" severity="secondary" :text="true" label="Cancel" @click="cancel" />
        </footer>
    </div>
</template>
