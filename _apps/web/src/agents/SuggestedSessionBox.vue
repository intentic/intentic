<script setup lang="ts">
import { AnchoredOverlay, BottomSheet, useDevice } from "@intentic-app/ui";
import { computed, nextTick, onMounted, ref } from "vue";
import ChatModelPicker from "../chat/ChatModelPicker.vue";
import ProviderLogo from "../chat/ProviderLogo.vue";
import type { Conversation } from "../composables/chat/conversation";
import { effortsFor } from "../composables/chat/effortScale";
import { modelLabelFor } from "../composables/chat/providerCatalog";

/* THE COMPOSER, LIFTED OUT OF THE CHAT — the box a suggested session is edited in before it is started.
 *
 * It is the chat composer's controls over a different Conversation, and deliberately not a lookalike: the same
 * model picker (ChatModelPicker, which is why that component takes the conversation it edits), the same effort
 * segments and the same fill ramp, the same `composer-*` classes out of chat.css. A second implementation would
 * have drifted on the first model the catalog added, and the whole promise of this dialog is that the turn it
 * proposes is a turn the user could have composed themselves.
 *
 * WHAT IT LEAVES OUT is as deliberate. No attachments, no @-mentions, no slash commands, no dictation, no mode
 * menu: those are for composing a task from nothing, and this box opens with the task already written. What
 * remains is exactly the two axes the user is being asked to approve — what to say, and what to spend saying it.
 */

const { conversation, action, busy = false } = defineProps<{ conversation: Conversation; action: string; busy?: boolean }>();
const emit = defineEmits<{ start: [] }>();

const { provider, model, thinking, effort, capabilities } = conversation;
const { mobile } = useDevice();

const input = ref<HTMLTextAreaElement | null>(null);
// The pill IS the anchor: AnchoredOverlay derives the document it teleports into, the viewport it measures the
// room against, and the click that never dismisses it, all from this element — so this box works unchanged
// wherever it is mounted (the app-wide dialog, the push dialog, a popped-out window).
const modelPill = ref<HTMLElement>();
const modelOpen = ref(false);
const modelSheetOpen = ref(false);

const modelLabelText = computed(() => modelLabelFor(provider.value, model.value));

// The scale is offered only where the runtime forwards it — the same guard the chat composer applies, for the
// same reason: an ACP agent owns its own reasoning settings, so segments there would be buttons that change
// nothing.
const efforts = computed(() => (capabilities.value.effort ? effortsFor(provider.value, model.value, thinking.value) : []));
const effortIndex = computed(() => efforts.value.findIndex((e) => e.value === effort.value));
const effortLabel = computed(() => efforts.value.find((e) => e.value === effort.value)?.label ?? effort.value);
const effortFill = (i: number): string => {
    const top = Math.max(1, efforts.value.length - 1);
    const pct = 50 + (i / top) * 45; // Low ≈ 50% brand → top level ≈ 95% brand
    return `color-mix(in oklab, var(--color-primary-500) ${pct}%, transparent)`;
};

// Manual auto-grow, the composer's own: reset to one line, then size to content up to the max-height. The box
// opens on a composed prompt rather than an empty line, so this runs once at mount or it opens one row tall
// over a twelve-line message.
const grow = (): void => {
    const el = input.value;
    if (el === null) {
        return;
    }
    el.style.height = `auto`;
    el.style.height = `${el.scrollHeight}px`;
};

const canStart = computed(() => !busy && conversation.draft.value.trim() !== ``);
const start = (): void => {
    if (canStart.value) {
        emit(`start`);
    }
};

/* Ctrl/Cmd+Enter sends; a bare Enter is a newline. The chat composer has this the other way round, and the
 * inversion is right here: this box opens with text already in it, so the first thing a user does is EDIT —
 * and a bare Enter that fired a frontier-model turn mid-sentence is the one mistake this dialog must not
 * make. The button's hint says so. */
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Enter` && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        start();
    }
};

onMounted(() => {
    void nextTick(() => {
        grow();
        // Caret at the end, not selecting the whole prompt: the common edit is an addition, and a text
        // selection that a single keystroke would wipe out is a trap over a message the app just wrote.
        const el = input.value;
        if (el !== null && !mobile.value) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
        }
    });
});
</script>

<template>
    <div class="rounded-xl border border-line bg-canvas focus-within:border-line-strong">
        <textarea
            ref="input"
            rows="1"
            v-model="conversation.draft.value"
            class="scrollbar-thin block max-h-64 w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-base leading-relaxed text-content placeholder:text-subtle focus:outline-none md:text-xs"
            placeholder="What should the agent do?"
            @input="grow"
            @keydown="onKeydown"
        ></textarea>

        <div class="flex items-center gap-1 px-2 pb-2">
            <button
                ref="modelPill"
                type="button"
                class="composer-ghost h-8 min-w-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
                @click="mobile ? (modelSheetOpen = true) : (modelOpen = !modelOpen)"
                :aria-expanded="modelOpen"
                :aria-label="`Model: ${modelLabelText}`"
            >
                <ProviderLogo :provider="provider" class="shrink-0 text-2xs text-link" />
                <span class="truncate">{{ modelLabelText }}</span>
                <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" />
            </button>

            <div v-if="efforts.length > 0" class="flex shrink-0 items-center gap-1.5" role="group" aria-label="Reasoning effort">
                <div class="flex items-center">
                    <button
                        v-for="(e, i) in efforts"
                        :key="e.value"
                        type="button"
                        class="composer-effort-seg"
                        :style="i <= effortIndex ? { backgroundColor: effortFill(i) } : undefined"
                        @click="conversation.setEffort(e.value)"
                        :aria-label="e.label"
                        :aria-pressed="effort === e.value"
                    ></button>
                </div>
                <span class="text-2xs text-subtle">{{ effortLabel }}</span>
            </div>

            <button
                type="button"
                class="composer-ghost ml-auto h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium text-link disabled:opacity-40 max-md:h-11"
                :disabled="!canStart"
                v-tooltip.top="'Ctrl+Enter'"
                @click="start"
            >
                <Icon :name="busy ? `spinner` : `send`" :spin="busy" class="text-2xs" />
                <span>{{ action }}</span>
            </button>
        </div>

        <!-- The same picker body the chat composer raises, over THIS conversation, in the same overlay — no
             height cap, because AnchoredOverlay measures the room its side of the pill actually has and the
             `min-h-0` column passes that cap down to the picker's list. Remounted per open, which is what lets
             ChatModelPicker bind its conversation's refs once. -->
        <BottomSheet v-if="mobile" v-model="modelSheetOpen" header="Model">
            <ChatModelPicker :conversation="conversation" @selected="modelSheetOpen = false" />
        </BottomSheet>
        <AnchoredOverlay v-else v-model="modelOpen" :anchor="modelPill">
            <div class="flex min-h-0 w-[26rem] flex-col">
                <ChatModelPicker :conversation="conversation" @selected="modelOpen = false" />
            </div>
        </AnchoredOverlay>
    </div>
</template>
