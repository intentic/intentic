<script setup lang="ts">
import type { DeliverableKind } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import ResultPreview from "../../../workspace/viewers/results/ResultPreview.vue";
import { saveResult } from "../../../workspace/viewers/results/resultFiles";
import { setHtmlPreviewed } from "../../../workspace/viewers/html/htmlPreviewed";
import { useChatSurface } from "../../tools/chatToolSurface";
import { type ChatDeliverable, deliverableName } from "./deliverables";

// The documents a finished turn made or changed, under its answer where it is read: one chip each, the file's name over
// what kind of document it is, a press opening it in the editor's viewer for that kind. A web page opens rendered, since
// a person opening it from here wants the page rather than its source (htmlPreviewed.ts). Where the chat can reach the
// conversation's recorded results, each chip also downloads its document and prints it, and a reader with no Files to
// open it in (a guest) gets the document over the chat instead (ResultPreview).

const t = useT();

// `label` names the row where it is not one turn's (a conversation's whole results, PlainResultReview).
const props = defineProps<{ deliverables: readonly ChatDeliverable[]; label?: string }>();

// Absent where nothing can be opened (a card mounted outside a chat); the chips still say what the turn made.
const surface = useChatSurface();
const openFile = surface.openFile;
const conversationId = computed(() => surface.resultConversation?.());
const resultBox = computed(() => surface.resultBox?.());
// The document over the chat: which one, whether it is showing, and whether it prints as soon as it is drawn.
const previewPath = ref(``);
const previewOpen = ref(false);
const printOnOpen = ref(false);
const actionError = ref<string>();

const download = async (path: string): Promise<void> => {
    if (conversationId.value === undefined) {
        return;
    }
    actionError.value = undefined;
    try {
        await saveResult(conversationId.value, path, resultBox.value);
    } catch {
        actionError.value = t(`workspace.results.downloadFailed`);
    }
};

const preview = (path: string, printing = false): void => {
    previewPath.value = path;
    printOnOpen.value = printing;
    previewOpen.value = true;
};

// The glyph, its tint (the file tree's own category hues) and the words per kind.
const LOOK = {
    docx: { icon: `file-edit`, tint: `text-file-code`, kind: () => t(`chat.chatTurnDeliverables.word`) },
    odt: { icon: `file-edit`, tint: `text-file-code`, kind: () => t(`chat.chatTurnDeliverables.odt`) },
    rtf: { icon: `file-edit`, tint: `text-file-code`, kind: () => t(`chat.chatTurnDeliverables.rtf`) },
    pptx: { icon: `picture-in-picture`, tint: `text-file-style`, kind: () => t(`chat.chatTurnDeliverables.slides`) },
    odp: { icon: `picture-in-picture`, tint: `text-file-style`, kind: () => t(`chat.chatTurnDeliverables.odp`) },
    xlsx: { icon: `th-large`, tint: `text-file-data`, kind: () => t(`chat.chatTurnDeliverables.sheet`) },
    ods: { icon: `th-large`, tint: `text-file-data`, kind: () => t(`chat.chatTurnDeliverables.ods`) },
    pdf: { icon: `file-pdf`, tint: `text-danger`, kind: () => t(`chat.chatTurnDeliverables.pdf`) },
    html: { icon: `globe`, tint: `text-file-doc`, kind: () => t(`chat.chatTurnDeliverables.page`) },
} satisfies Record<DeliverableKind, { readonly icon: IconName; readonly tint: string; readonly kind: () => string }>;

const chips = computed(() =>
    props.deliverables.map((deliverable) => {
        const look = LOOK[deliverable.kind];
        return { deliverable, name: deliverableName(deliverable.path), kind: look.kind(), icon: look.icon, tint: look.tint };
    }),
);

// Over the chat for a reader with no Files, or where nothing else can open it; in the viewer for everyone else.
const inPlace = computed(() => conversationId.value !== undefined && (surface.resultsInPlace?.() === true || openFile === undefined));
const openable = computed(() => inPlace.value || openFile !== undefined);

const open = (deliverable: ChatDeliverable): void => {
    if (inPlace.value) {
        preview(deliverable.path);
        return;
    }
    if (deliverable.kind === `html`) {
        setHtmlPreviewed(deliverable.path, true);
    }
    openFile?.(deliverable.path);
};

const ACTION = `flex shrink-0 items-center gap-1 px-2 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content`;
</script>

<template>
    <!-- Inset like the answer's own prose, as the turn's pictures are (ChatTurnShots). -->
    <section class="flex flex-wrap gap-1.5 px-3.5" :aria-label="label ?? t(`chat.chatTurnDeliverables.region`)">
        <div
            v-for="chip in chips"
            :key="chip.deliverable.path"
            class="chat-inset flex min-w-0 max-w-full items-stretch overflow-hidden border border-line transition-colors hover:border-line-strong"
        >
            <button
                type="button"
                class="flex min-w-0 max-w-64 items-center gap-2 py-1.5 pr-3 pl-2 text-left enabled:cursor-pointer"
                :disabled="!openable"
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
            <!-- What a person does with a result besides reading it, beside it in words, not behind a menu. -->
            <template v-if="conversationId !== undefined">
                <button
                    type="button"
                    :class="[ACTION, `border-l border-line`]"
                    :aria-label="t(`workspace.results.downloadNamed`, { name: chip.name })"
                    @click="download(chip.deliverable.path)"
                >
                    <Icon name="download" />
                    <span>{{ t(`workspace.results.download`) }}</span>
                </button>
                <button
                    type="button"
                    :class="ACTION"
                    :aria-label="t(`workspace.results.printNamed`, { name: chip.name })"
                    @click="preview(chip.deliverable.path, true)"
                >
                    <Icon name="print" />
                    <span>{{ t(`workspace.results.print`) }}</span>
                </button>
            </template>
        </div>
        <p v-if="actionError" role="alert" class="w-full text-xs text-danger">{{ actionError }}</p>
        <!-- Inside the one root, so a caller's class reaches the row; the dialog itself is drawn over the page. -->
        <ResultPreview
            v-if="conversationId !== undefined && previewPath !== ``"
            v-model:open="previewOpen"
            :conversation-id="conversationId"
            :path="previewPath"
            :at="resultBox"
            :print-on-open="printOnOpen"
        />
    </section>
</template>
