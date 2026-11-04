import type { ConversationQueue } from "@intentic/sandbox-contract/schemas/agent";
import { computed, type Ref, shallowRef, watch } from "vue";
import { uuid } from "../../../lib/uuid";
import type { ChatAttachment, ChatMessage } from "../transcript/transcript";

// Words this window has sent and not yet seen land: from the press until the sandbox's own row for them (said into the
// running turn) or its queue (waiting behind it) shows them here. A send into a live turn draws no bubble of its own,
// since a user row under the streaming answer would split it (liveBubbleOf), so without this the words vanished from
// the composer and showed up seconds later on a loaded sandbox, with nothing in between. Drawn at the transcript's foot
// (ChatSendingMessages), outside the rows the turn writes into.

export interface SendingWords {
    // Names the entry from the press on; the message id comes later, once the send has minted it.
    readonly key: string;
    readonly text: string;
    readonly attachments: readonly string[];
    readonly sentAt: number;
    readonly messageId: string | undefined;
}

export interface SendingHost {
    readonly queue: Readonly<Ref<ConversationQueue | undefined>>;
    readonly messages: Readonly<Ref<readonly ChatMessage[]>>;
}

// How long words the sandbox took wait to be seen here before they go anyway: a row this window never draws (a turn it
// does not follow, a queue frame that never comes) must not leave them standing.
export const SENDING_SEEN_MS = 15_000;

export class SendingList {
    private readonly entries = shallowRef<readonly SendingWords[]>([]);

    // What still has nothing else on screen saying it: a row or a queued message under its id ends it in the same frame.
    readonly shown = computed<readonly SendingWords[]>(() => {
        const entries = this.entries.value;
        // Read only while something is in flight, so a streamed turn's frames cost nothing here otherwise.
        return entries.length === 0 ? entries : entries.filter((entry) => !this.seen(entry));
    });

    constructor(private readonly host: SendingHost) {}

    begin(text: string, attachments: readonly ChatAttachment[]): string {
        const key = uuid();
        this.entries.value = [...this.entries.value, { key, text, attachments: attachments.map((file) => file.path), sentAt: Date.now(), messageId: undefined }];
        return key;
    }

    // The id the words went out under, which the sandbox's row and queue name them by.
    named(key: string, messageId: string): void {
        this.entries.value = this.entries.value.map((entry) => (entry.key === key ? { ...entry, messageId } : entry));
    }

    // Nothing more to say: handed back, gone to the outbox (which draws its own bubble), or drawn some other way.
    end(key: string): void {
        if (this.entries.value.some((entry) => entry.key === key)) {
            this.entries.value = this.entries.value.filter((entry) => entry.key !== key);
        }
    }

    // The sandbox took them: they go once seen here, or after SENDING_SEEN_MS whatever happened.
    taken(key: string): void {
        const entry = this.entries.value.find((standing) => standing.key === key);
        if (entry === undefined) {
            return;
        }
        if (this.seen(entry)) {
            this.end(key);
            return;
        }
        const finish = (): void => {
            clearTimeout(timer);
            stop();
            this.end(key);
        };
        const timer = setTimeout(finish, SENDING_SEEN_MS);
        // Sync: a frame that shows the words and one that lets them go (a queued message going out as a turn) can land
        // in the same tick, and a deferred look would find them unseen again.
        const stop = watch(
            () => this.seen(entry),
            (seen) => {
                if (seen) {
                    finish();
                }
            },
            { flush: `sync` },
        );
    }

    private seen(entry: SendingWords): boolean {
        const id = entry.messageId;
        if (id === undefined) {
            return false;
        }
        if (this.host.queue.value?.items.some((item) => item.id === id) === true) {
            return true;
        }
        return this.host.messages.value.some((message) => message.role === `user` && message.messageId === id && message.unsent !== true);
    }
}
