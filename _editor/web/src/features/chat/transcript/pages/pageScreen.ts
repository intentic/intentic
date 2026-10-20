import type { Page } from "@intentic/sandbox-contract/events/requests";
import { computed, inject, type InjectionKey, ref, shallowRef, watch } from "vue";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import { Conversation } from "../../../../models/conversations/session/conversation";
import { type AgentTranscript, freshAgentTranscript, olderTranscriptPage } from "../../../../models/conversations/transcript/agentTranscript";
import { answerOnPage } from "./pageAnswer";
import { findPage, standingDrawing } from "./pageLookup";

// THE FULL-SCREEN PAGE'S STATE (ChatPageScreen.vue): the drawing of one page that stands, found by its id in its
// conversation's record (pageLookup.ts), and the answer flow of a page that asks, the same as its card's in the chat.
//
// The record is held as a conversation nobody sends to, as a subagent's is (subagentRecord.ts): never a tab and never
// mirrored to disk, its rows the daemon's read, replaced whole on each one. One per conversation, kept across reads, so
// an answer on its way survives the next read; an answer given here settles its row at once (CardReplies).

/** How the screen reads a conversation's record: its newest page, and the page above a cursor. */
export interface PageRecordReader {
    readonly opening: (conversationId: string) => Promise<AgentTranscript>;
    readonly older: (conversationId: string, before: number) => Promise<AgentTranscript>;
}

// Past the cache for the newest page: the screen is opened for a page drawn moments ago, which a cached read predates.
const DAEMON: PageRecordReader = { opening: (id) => freshAgentTranscript(id), older: (id, before) => olderTranscriptPage(id, before) };

export const PAGE_RECORD_READER: InjectionKey<PageRecordReader> = Symbol(`intentic.page-record-reader`);

/** Where a read stands: still reading, found, or why there is nothing to draw. */
export type PageReading = `reading` | `found` | `missing` | `gone` | `failed`;

export const usePageScreen = (conversationId: () => string, pageId: () => string) => {
    const reader = inject(PAGE_RECORD_READER, DAEMON);
    const record = shallowRef(new Conversation(conversationId()));
    const reading = ref<PageReading>(`reading`);

    // Reads the record again, keeping what is drawn until the answer is in: a drawing that still stands is not redrawn,
    // so nobody loses what they were doing on the page to a read.
    let reads = 0;
    const read = async (): Promise<void> => {
        const ask = ++reads;
        const id = conversationId();
        const held = record.value;
        try {
            const found = await findPage(pageId(), await reader.opening(id), (before) => reader.older(id, before));
            if (ask !== reads) {
                return;
            }
            if (found.kind === `found`) {
                held.transcript.rebuild(found.rows);
            }
            reading.value = found.kind;
        } catch {
            if (ask === reads) {
                reading.value = `failed`;
            }
        }
    };

    watch(conversationId, (id) => {
        record.value = new Conversation(id);
    });
    watch(
        [conversationId, pageId],
        () => {
            reading.value = `reading`;
            void read();
        },
        { immediate: true },
    );

    // The row whose drawing stands, read off the record's own messages, so an answer given here shows on it at once.
    const message = computed(() => (reading.value === `found` ? standingDrawing(record.value.transcript.messages.value, pageId()) : undefined));
    const page = computed((): Page | undefined => message.value?.page ?? message.value?.pageAsk?.page);
    const asked = computed(() => message.value?.pageAsk);
    const requestId = computed(() => asked.value?.requestId);
    const settling = computed(() => requestId.value !== undefined && record.value.requests.isReplying(requestId.value));

    const reply = async (answer: CardAnswer): Promise<void> => {
        if (requestId.value !== undefined) {
            await record.value.requests.reply(requestId.value, answer);
        }
    };
    // An asked page answers through the conversation's one reply, as on its card; a page that asks nothing has no answer.
    const submit = computed(() =>
        asked.value === undefined
            ? undefined
            : answerOnPage(
                  () => asked.value,
                  () => settling.value,
                  reply,
              ),
    );

    return {
        record,
        reading,
        read,
        page,
        asked,
        settling,
        submit,
        dismiss: (): Promise<void> => reply({ kind: `page_ask`, cancelled: true }),
    };
};
