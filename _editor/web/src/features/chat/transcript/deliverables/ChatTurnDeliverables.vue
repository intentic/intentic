<script setup lang="ts">
import type { DeliverableKind } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { setHtmlPreviewed } from "../../../workspace/viewers/html/htmlPreviewed";
import { useChatSurface } from "../../tools/chatToolSurface";
import { type ChatDeliverable, deliverableName } from "./deliverables";

// The documents a finished turn made or changed, under its answer where it is read: one chip each, the file's name over
// what kind of document it is, a press opening it in the editor's viewer for that kind. A web page opens rendered, since
// a person opening it from here wants the page rather than its source (htmlPreviewed.ts).

const t = useT();

const props = defineProps<{ deliverables: readonly ChatDeliverable[] }>();

// Absent where nothing can be opened (a card mounted outside a chat); the chips still say what the turn made.
const openFile = useChatSurface().openFile;

// The glyph, its tint (the file tree's own category hues) and the words per kind.
const LOOK = {
    docx: { icon: `file-edit`, tint: `text-file-code`, kind: () => t(`chat.chatTurnDeliverables.word`) },
    pptx: { icon: `picture-in-picture`, tint: `text-file-style`, kind: () => t(`chat.chatTurnDeliverables.slides`) },
    xlsx: { icon: `th-large`, tint: `text-file-data`, kind: () => t(`chat.chatTurnDeliverables.sheet`) },
    pdf: { icon: `file-pdf`, tint: `text-danger`, kind: () => t(`chat.chatTurnDeliverables.pdf`) },
    html: { icon: `globe`, tint: `text-file-doc`, kind: () => t(`chat.chatTurnDeliverables.page`) },
} satisfies Record<DeliverableKind, { readonly icon: IconName; readonly tint: string; readonly kind: () => string }>;

const chips = computed(() =>
    props.deliverables.map((deliverable) => {
        const look = LOOK[deliverable.kind];
        return { deliverable, name: deliverableName(deliverable.path), kind: look.kind(), icon: look.icon, tint: look.tint };
    }),
);

const open = (deliverable: ChatDeliverable): void => {
    if (deliverable.kind === `html`) {
        setHtmlPreviewed(deliverable.path, true);
    }
    openFile?.(deliverable.path);
};
</script>

<template>
    <!-- Inset like the answer's own prose, as the turn's pictures are (ChatTurnShots). -->
    <section class="flex flex-wrap gap-1.5 px-3.5" :aria-label="t(`chat.chatTurnDeliverables.region`)">
        <button
            v-for="chip in chips"
            :key="chip.deliverable.path"
            type="button"
            class="chat-inset flex min-w-0 max-w-64 items-center gap-2 border border-line py-1.5 pr-3 pl-2 text-left transition-colors enabled:cursor-pointer enabled:hover:border-line-strong"
            :disabled="!openFile"
            :aria-label="t(`chat.chatTurnDeliverables.open`, { name: chip.name, kind: chip.kind })"
            v-tooltip.top="chip.deliverable.path"
            @click="open(chip.deliverable)"
        >
            <Icon :name="chip.icon" class="shrink-0 text-sm" :class="chip.tint" />
            <span class="flex min-w-0 flex-col">
                <span class="truncate text-xs font-medium text-content">{{ chip.name }}</span>
                <span class="truncate text-2xs text-subtle">{{ chip.kind }}</span>
            </span>
        </button>
    </section>
</template>
