<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { basename } from "@intentic/ui/path";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import type { SendingWords } from "../../../../models/conversations/session/sendingWords";

/* Words just sent that nothing else on screen shows yet (TurnClient.sending): said into a running turn, or behind one ending, before the sandbox's own row or its queue has them. Drawn as the prompt they will be, faded, with the one line that says they are on their way; each fades in only once a send has taken a moment (chat-sending), so an ordinary send that lands at once never flickers one. */

// Past this the line says the sandbox is slow to answer, rather than only that the words are going.
const SLOW_MS = 5_000;

const t = useT();
const { sending } = usePaneView();
const now = useNow(() => sending.value.length > 0);

const wordsOf = (entry: SendingWords): string => (entry.text.length > 0 ? entry.text : entry.attachments.map((path) => basename(path)).join(`, `));
const lineOf = (entry: SendingWords): string => (now.value - entry.sentAt >= SLOW_MS ? t(`chat.chatSending.stillSending`) : t(`chat.chatSending.sending`));
</script>

<template>
    <div v-if="sending.length > 0" class="flex flex-col items-end gap-2 pt-1" data-testid="chat-sending">
        <div v-for="entry in sending" :key="entry.key" class="chat-sending flex max-w-[85%] flex-col items-end gap-1" role="status">
            <div class="chat-surface chat-surface-held min-w-0">
                <div class="chat-prompt-text px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted">{{ wordsOf(entry) }}</div>
            </div>
            <span class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-2xs" />
                <span>{{ lineOf(entry) }}</span>
            </span>
        </div>
    </div>
</template>
