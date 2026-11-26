<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toneWash, ui, vAction } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { dragWindow } from "../dragWindow";
import { useFitToContent } from "../fitWindow";
import { cardView, quitCardAnswer, readCard, type Choice } from "./quitCard";

const t = useT();

/* EVERY QUESTION A CLOSE OR A QUIT ASKS, ON ONE CARD (windows/quit_card.rs gathers it, quitCard.ts words it). */
const card = readCard();
// Reads the webview's own user agent rather than a round trip, so the window isn't delayed by a shell-out.
const onWindows = navigator.userAgent.includes(`Windows`);
const view = computed(() => cardView(card, onWindows));

const remember = ref(false);
const content = ref<HTMLElement | undefined>(undefined);
useFitToContent(content);

// Escape, the card's own ×, or "Go back" means "I didn't mean to": nothing is remembered, and this window simply closes,
// which the app hears as the quit taken back.
const cancel = (): Promise<void> => getCurrentWindow().close();

const choose = (choice: Choice): Promise<void> =>
    choice.answer === `back` ? cancel() : quitCardAnswer(choice.answer, choice.keepSandboxes, remember.value);

/** The recoverable answer is first and reads as the suggestion; one that loses something says so in red. */
const answerTone = (choice: Choice, index: number): `danger` | `primary` | `neutral` => {
    if (choice.danger) {
        return `danger`;
    }
    return index === 0 ? `primary` : `neutral`;
};

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        void cancel();
    }
};

onMounted(() => {
    window.addEventListener(`keydown`, onKey);
    // Focused so Return picks the recoverable answer (the tray, waiting, going back), never the one that loses something.
    content.value?.querySelector<HTMLButtonElement>(`[data-answer]`)?.focus();
});
onUnmounted(() => window.removeEventListener(`keydown`, onKey));
</script>

<template>
    <div class="h-dvh overflow-auto bg-canvas text-content">
        <div ref="content" class="flex flex-col gap-4 p-5">
            <!-- The header is the title bar: every press on it that isn't the × moves the window (dragWindow.ts). -->
            <header class="flex items-start gap-3 select-none" @mousedown="dragWindow">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 class="text-base font-semibold">{{ view.title }}</h1>
                    <p v-if="view.lead" class="text-xs text-muted">{{ view.lead }}</p>
                </div>
                <button type="button" :class="ui.iconButton({ size: `md` }, `-my-0.5`)" :aria-label="t(`ui.action.cancel`)" @click="cancel">
                    <Icon name="times" />
                </button>
            </header>

            <!-- What a quit would interrupt, costliest first: the circle's colour says what quitting does to it (lost,
                 stopped, or carrying on), and the line under it says it in words. -->
            <ul v-if="view.facts.length > 0" class="flex flex-col gap-3">
                <li v-for="fact in view.facts" :key="fact.key" class="flex items-start gap-3">
                    <span :class="toneWash(fact.tone, `grid size-7 shrink-0 place-items-center rounded-full text-sm`)">
                        <Icon :name="fact.icon" />
                    </span>
                    <span class="min-w-0 flex-1">
                        <span class="block text-xs font-medium">{{ fact.title }}</span>
                        <span class="block text-2xs text-muted">{{ fact.outcome }}</span>
                    </span>
                </li>
            </ul>

            <!-- The answers as things to press, each a whole outcome, not a radio group and a confirm button. -->
            <div class="flex flex-col gap-2">
                <button
                    v-for="(choice, index) in view.choices"
                    :key="choice.key"
                    type="button"
                    data-answer
                    class="flex w-full cursor-pointer items-start gap-3 rounded-lg bg-card shadow-sm p-3 text-left transition-colors hover:bg-overlay focus-visible:border-primary-500 focus-visible:outline-none text-xs"
                    v-action="() => choose(choice)"
                >
                    <span :class="toneWash(answerTone(choice, index), `grid size-8 shrink-0 place-items-center rounded-lg text-base`)">
                        <Icon :name="choice.icon" />
                    </span>
                    <span class="min-w-0 flex-1 self-center">
                        <span class="block text-xs font-medium" :class="{ 'text-danger': choice.danger }">{{ choice.title }}</span>
                        <span class="block text-2xs text-muted">{{ choice.hint }}</span>
                        <span v-if="choice.note" class="mt-1 block text-2xs text-subtle">{{ choice.note }}</span>
                    </span>
                </button>
            </div>

            <!-- The one control that retires the question for good, which is what makes asking at all defensible. -->
            <label v-if="view.canRemember" class="flex cursor-pointer items-center gap-2 text-2xs text-muted">
                <Checkbox v-model="remember" :binary="true" />
                <span>{{ t(`desktop.quitCard.remember`) }}</span>
            </label>
            <!-- The sandboxes question is never asked twice: its answer is the setting from now on. -->
            <p v-if="view.asksSandboxes" class="text-2xs text-subtle">{{ t(`desktop.quitCard.remembersSandboxes`) }}</p>
        </div>
    </div>
</template>
