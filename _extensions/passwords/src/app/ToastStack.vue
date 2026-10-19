<!-- "Saved github.com · from Brave · Undo · View": what was remembered without asking, bottom right, gone after 8 s unless the pointer rests on it. -->
<script setup lang="ts">
import { Icon, messageOr, ui } from "@intentic/extension-ui";
import { onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n.js";
import type { PasswordsPort } from "./port.js";
import type { Toast } from "./state.js";

const { toasts, port } = defineProps<{ toasts: readonly Toast[]; port: PasswordsPort }>();
const emit = defineEmits<{ dismiss: [id: number]; view: [name: string]; undone: [] }>();

const SHOWN_MS = 8000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const said = ref(new Map<number, string>());

const start = (id: number): void => {
    clearTimeout(timers.get(id));
    timers.set(
        id,
        setTimeout(() => emit(`dismiss`, id), SHOWN_MS),
    );
};
const pause = (id: number): void => {
    clearTimeout(timers.get(id));
    timers.delete(id);
};

watch(
    () => toasts.map((toast) => toast.id),
    (ids) => {
        for (const id of ids) {
            if (!timers.has(id)) {
                start(id);
            }
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => {
    for (const timer of timers.values()) {
        clearTimeout(timer);
    }
});

const undo = async (toast: Toast): Promise<void> => {
    pause(toast.id);
    try {
        await port.undo(toast.name, toast.at);
        said.value.set(toast.id, t(`app.toast.undone`));
        emit(`undone`);
    } catch (failure) {
        said.value.set(toast.id, messageOr(failure, t(`app.error.act`)));
    }
    start(toast.id);
};
</script>

<template>
    <div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
        <TransitionGroup name="passwords-toast">
            <div
                v-for="toast in toasts"
                :key="toast.id"
                class="pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-lg"
                @mouseenter="pause(toast.id)"
                @mouseleave="start(toast.id)"
                @focusin="pause(toast.id)"
                @focusout="start(toast.id)"
            >
                <Icon name="check-circle" class="mt-0.5 text-success" />
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <p class="text-sm text-content">
                        <span class="font-medium">{{ toast.outcome === `updated` ? t(`app.toast.updated`, { title: toast.title }) : t(`app.toast.saved`, { title: toast.title }) }}</span>
                        <span class="text-muted"> · {{ t(`app.toast.from`, { via: toast.via }) }}</span>
                    </p>
                    <p v-if="said.get(toast.id)" class="text-xs text-muted">{{ said.get(toast.id) }}</p>
                    <div v-else class="flex gap-3">
                        <button type="button" :class="ui.textButton({ size: `xs`, flush: true })" @click="undo(toast)">{{ t(`app.toast.undo`) }}</button>
                        <button type="button" :class="ui.textButton({ size: `xs`, flush: true })" @click="emit(`view`, toast.name)">{{ t(`app.toast.view`) }}</button>
                    </div>
                </div>
                <button type="button" :class="ui.iconButton({ size: `xs` })" :aria-label="t(`app.toast.dismiss`)" @click="emit(`dismiss`, toast.id)">
                    <Icon name="times" />
                </button>
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
/* Correct as CSS: a transition's enter and leave states are class pairs Vue toggles, which no utility can name. */
.passwords-toast-enter-active,
.passwords-toast-leave-active {
    transition:
        opacity 160ms ease,
        transform 160ms ease;
}
.passwords-toast-enter-from,
.passwords-toast-leave-to {
    opacity: 0;
    transform: translateY(0.5rem);
}
/* The Appearance setting's motion, which follows the OS until the person pins it (@intentic/ui motion.css). */
:global(:root[data-motion="reduced"]) .passwords-toast-enter-active,
:global(:root[data-motion="reduced"]) .passwords-toast-leave-active {
    transition: none;
}
</style>
