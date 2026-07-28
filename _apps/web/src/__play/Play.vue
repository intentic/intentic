<script setup lang="ts">
import { ref } from "vue";
import type { ChatMessage } from "../composables/chat/transcript";
import ChatMessageView from "../chat/ChatMessageView.vue";

/* Throwaway: renders the REAL ChatMessageView inside a hand-built copy of ChatPanel's ancestor chain
 * (.chat-panel > @container > .chat-scroller > .chat-turns) at a set of panel widths, so the attachment
 * layout's container-query threshold and the resulting prompt measure can be looked at and measured. */

const swatch = (fill: string): string =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="${fill}"/><text x="120" y="90" font-size="28" text-anchor="middle" fill="white">IMG</text></svg>`,
    )}`;

const WIDTHS = [288, 352, 448, 512, 544, 720];

const make = (id: number, text: string, attachments: ChatMessage[`attachments`]): ChatMessage => ({
    id,
    role: `user`,
    text,
    attachments,
    checkpointId: `snap-${id}`,
});

const CASES: { label: string; message: ChatMessage }[] = [
    { label: `1 image + short prompt`, message: make(1, `Fix the header spacing.`, [{ name: `shot.png`, path: `a/shot.png`, previewUrl: swatch(`#3b6ea5`) }]) },
    {
        label: `1 image + long prompt (clamps at 6 lines)`,
        message: make(
            2,
            `In intentic-app/web chat instead of taking 2 rows (one for images, one for text) the images could be placed on left side from text. That would also allow the overlay to position nicely on left side. As UX expert analyze feasibility and soundness of such improvement.`,
            [{ name: `shot.png`, path: `b/shot.png`, previewUrl: swatch(`#7a4fa3`) }],
        ),
    },
    {
        label: `3 images + prompt`,
        message: make(3, `Compare these three states.`, [
            { name: `one.png`, path: `c/one.png`, previewUrl: swatch(`#2f7d5a`) },
            { name: `two.png`, path: `c/two.png`, previewUrl: swatch(`#a35f2f`) },
            { name: `three.png`, path: `c/three.png`, previewUrl: swatch(`#a32f4f`) },
        ]),
    },
    {
        label: `mixed image + file chip (must stay stacked)`,
        message: make(4, `Use the log to explain the screenshot.`, [
            { name: `shot.png`, path: `d/shot.png`, previewUrl: swatch(`#3b6ea5`) },
            { name: `very-long-diagnostic-filename.log`, path: `d/very-long-diagnostic-filename.log` },
        ]),
    },
    {
        label: `attachment only, no text (must stay stacked)`,
        message: make(5, ``, [{ name: `shot.png`, path: `e/shot.png`, previewUrl: swatch(`#555f6a`) }]),
    },
    { label: `no attachments (unchanged)`, message: make(6, `Plain prompt with no attachments at all.`, undefined) },
];

const width = ref(352);
</script>

<template>
    <div class="flex flex-col gap-6 p-6">
        <div class="flex flex-wrap items-center gap-2">
            <button
                v-for="w in WIDTHS"
                :key="w"
                type="button"
                class="rounded border border-line px-2 py-1 text-xs"
                :class="w === width ? 'bg-primary-500 text-white' : 'text-content'"
                @click="width = w"
            >
                {{ w }}px
            </button>
            <span class="text-xs text-subtle">panel width · @lg fires at a 512px container</span>
        </div>
        <div class="flex flex-wrap items-start gap-6">
            <div v-for="c in CASES" :key="c.message.id" class="flex flex-col gap-1">
                <span class="text-2xs text-subtle">{{ c.label }}</span>
                <!-- ChatPanel's ancestor chain, copied so the geometry is the real one. -->
                <div class="chat-panel relative flex h-full min-h-0 flex-col overflow-hidden bg-card" :style="{ width: `${width}px` }">
                    <div class="@container flex min-h-0 min-w-0 flex-1 flex-col">
                        <div class="chat-scroller scrollbar-thin flex flex-1 flex-col overflow-auto">
                            <div class="flex min-w-0 flex-1 flex-col">
                                <div class="chat-turns flex flex-1 flex-col gap-1 pt-4">
                                    <section class="flex flex-col gap-1">
                                        <ChatMessageView :message="c.message" :streaming="false" />
                                    </section>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
