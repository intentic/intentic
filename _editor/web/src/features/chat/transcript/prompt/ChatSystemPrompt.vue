<script setup lang="ts">
import type { ConversationPrompt, PromptSection } from "@intentic/sandbox-contract";
import { CopyButton, MarkdownDocument, Modal, Notice } from "@intentic/ui";
import { formatTokens, timeAgo } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { rpcQuery } from "../../../sandbox/client/rpcQuery";
import { useSandboxQuery } from "../../../sandbox/client/useSandboxQuery";
import { useT } from "@intentic/ui/i18n";

// THE ONE PART OF A TURN THE TRANSCRIPT CANNOT SHOW. A preamble note rides the message and is drawn beside it; the
// system prompt — this product's guidance, the persona, the sandbox's field notes, the workspace's standing rules —
// reaches the model and leaves no trace in the chat, so without this an arriving AGENTS.md and a dropped one look
// alike.
//
// It sits above the first prompt because that is where it sits in the conversation: all of it was said before the
// reader's first word.

const props = defineProps<{ conversationId: string }>();

const t = useT();

const open = ref(false);

// Fetched on the press, never with the transcript: a composed prompt is tens of kilobytes, and most readers never
// ask for it.
const { query, error } = useSandboxQuery<ConversationPrompt>({
    ...rpcQuery(`agents.systemPrompt`, () => ({ id: props.conversationId })),
    enabled: computed(() => open.value),
});

const disclosure = computed(() => query.data.value?.prompt);
const loading = computed(() => query.isFetching.value && disclosure.value === undefined);
// Nothing recorded happens for one reason only — the conversation's last turn predates this record — so it is said
// plainly rather than drawn as an empty list.
const missing = computed(() => query.isSuccess.value && disclosure.value === undefined);

interface Row {
    readonly key: string;
    readonly title: string;
    // Where it comes from, since the title alone doesn't say whose words these are.
    readonly whence: string;
    // Absent for a runtime that keeps its own prompt: there is a base, and it cannot be read from here.
    readonly text?: string;
}

// Written as literal keys rather than a lookup table: the catalogs are checked by reading these call sites, and a key
// reached through a variable reads there as a message nobody asks for.
const whenceOf = (source: PromptSection["source"]): string =>
    source === `persona`
        ? t(`chat.chatSystemPrompt.whencePersona`)
        : source === `field-notes`
          ? t(`chat.chatSystemPrompt.whenceFieldNotes`)
          : source === `memory`
            ? t(`chat.chatSystemPrompt.whenceMemory`)
            : t(`chat.chatSystemPrompt.whenceGuidance`);

const baseTitle = (base: NonNullable<ConversationPrompt["prompt"]>): string =>
    base.base.kind === `runtime`
        ? t(`chat.chatSystemPrompt.baseRuntime`, { runtime: base.runtime })
        : base.base.kind === `claude`
          ? t(`chat.chatSystemPrompt.baseClaude`)
          : base.base.kind === `custom`
            ? t(`chat.chatSystemPrompt.baseCustom`)
            : // Never labelled as anyone's own prompt: nobody wrote it, a small window is why it is there.
              base.base.kind === `trimmed`
              ? t(`chat.chatSystemPrompt.baseTrimmed`)
              : t(`chat.chatSystemPrompt.baseIntentic`);

// The base as the first row, then the additions in the order the model reads them: one list, top to bottom, is the
// prompt itself.
const rows = computed((): readonly Row[] => {
    const prompt = disclosure.value;
    if (prompt === undefined) {
        return [];
    }
    const base: Row = {
        key: `base`,
        title: baseTitle(prompt),
        // A trimmed base gets its own line for the same reason it gets its own title: the usual one says the prompt was
        // "chosen in your sandbox's agent settings", and this one was chosen by the model's window instead.
        whence:
            prompt.base.kind === `runtime`
                ? t(`chat.chatSystemPrompt.whenceOpaque`)
                : prompt.base.kind === `trimmed`
                  ? t(`chat.chatSystemPrompt.whenceTrimmed`)
                  : t(`chat.chatSystemPrompt.whenceBase`),
        ...(prompt.base.text === undefined ? {} : { text: prompt.base.text }),
    };
    return [
        base,
        ...prompt.sections.map((section) => ({ key: section.source, title: section.title, whence: whenceOf(section.source), text: section.text })),
    ];
});

// One row open at a time: the list is what the chip is for, and two open sections bury it.
const opened = ref<string>();
const toggle = (key: string): void => {
    opened.value = opened.value === key ? undefined : key;
};

// Everything that was sent, in one piece, for a reader who wants to diff it or keep it.
const whole = computed(() =>
    rows.value
        .flatMap((row) => (row.text === undefined ? [] : [row.text]))
        .join(`\n\n`)
        .trim(),
);

// A composed piece opens with the very heading the row above it already draws. Dropped from the reading, never from
// what is copied: the row is the title, and printing it twice makes the section look like it starts late.
const shown = (text: string, title: string): string => {
    const [first = ``, ...rest] = text.split(`\n`);
    return first.replace(/^#{1,6} /, ``).trim() === title ? rest.join(`\n`).trim() : text;
};
</script>

<template>
    <div class="flex justify-center pb-1">
        <button
            type="button"
            class="ui-chip cursor-pointer"
            :class="open && `ui-chip-on`"
            :aria-label="t(`chat.chatSystemPrompt.chip`)"
            v-tooltip.bottom="t(`chat.chatSystemPrompt.hint`)"
            @click="open = true"
        >
            <Icon name="align-left" class="text-2xs" />
            {{ t(`chat.chatSystemPrompt.chip`) }}
        </button>
    </div>

    <Modal v-model:open="open" size="lg" :header="t(`chat.chatSystemPrompt.title`)">
        <p class="text-xs text-muted">{{ t(`chat.chatSystemPrompt.lede`) }}</p>
        <div v-if="loading" class="flex items-center gap-2 py-6 text-xs text-muted">
            <Icon name="spinner" spin />
            {{ t(`chat.chatSystemPrompt.reading`) }}
        </div>
        <Notice v-else-if="error !== undefined" tone="danger" class="mt-3 text-2xs">{{ error }}</Notice>
        <Notice v-else-if="missing" tone="info" class="mt-3 text-2xs">{{ t(`chat.chatSystemPrompt.nothing`) }}</Notice>
        <template v-else-if="disclosure !== undefined">
            <!-- Which turn this was, because a persona switch or an edited AGENTS.md changes it mid-conversation. -->
            <p class="mt-1 text-2xs text-subtle">
                {{ t(`chat.chatSystemPrompt.composed`, { runtime: disclosure.runtime, when: timeAgo(disclosure.at, { days: true }) }) }}
            </p>
            <div class="mt-3 flex flex-col border-y border-line-subtle">
                <div v-for="row in rows" :key="row.key" class="flex flex-col border-b border-line-subtle last:border-b-0">
                    <button
                        type="button"
                        class="flex cursor-pointer items-center gap-2 py-2 text-left text-xs transition-colors hover:text-content"
                        :class="opened === row.key ? `text-content` : `text-muted`"
                        :aria-expanded="opened === row.key"
                        @click="toggle(row.key)"
                    >
                        <Icon :name="opened === row.key ? `chevron-down` : `chevron-right`" class="shrink-0 text-2xs" />
                        <span class="min-w-0 flex-1 truncate font-medium">{{ row.title }}</span>
                        <!-- Characters, not tokens: what a section costs is measurable here, what it tokenizes to is not. -->
                        <span
                            v-if="row.text !== undefined"
                            class="shrink-0 font-mono text-2xs text-subtle tabular-nums"
                            v-tooltip.left="t(`chat.chatSystemPrompt.characters`, { count: row.text.length })"
                        >
                            {{ formatTokens(row.text.length) }}
                        </span>
                    </button>
                    <!-- Shut until found rather than absent, so find-in-page reaches a section and opens it. -->
                    <div :hidden.attr="opened === row.key ? undefined : `until-found`" @beforematch="opened = row.key">
                        <div v-if="row.text !== undefined" class="pb-3">
                            <p class="mb-2 text-2xs text-subtle">{{ row.whence }}</p>
                            <!-- Capped and scrolled rather than clamped: one of these rows is the whole base prompt. -->
                            <div class="ui-softscroll max-h-[45dvh] overflow-auto" style="--prose-measure: 76ch">
                                <MarkdownDocument :model-value="shown(row.text, row.title)" :label="row.title" />
                            </div>
                            <div class="mt-2 flex justify-end">
                                <!-- Copies the section as it was sent, heading and all, whatever the reading above dropped. -->
                                <CopyButton :text="row.text" :label="t(`ui.action.copy`)" />
                            </div>
                        </div>
                        <p v-else class="pb-3 text-2xs text-subtle">{{ row.whence }}</p>
                    </div>
                </div>
            </div>
            <div class="mt-3 flex items-center justify-end gap-2">
                <CopyButton :text="whole" :label="t(`chat.chatSystemPrompt.copyAll`)" />
            </div>
        </template>
    </Modal>
</template>
