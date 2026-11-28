import { type RandomBytes, uuidv7 } from "@intentic/sandbox-contract/s2s";
import { S2S_MESSAGE_BYTES_MAX, type S2sMessageSend, type S2sMessageSendOutcome } from "@intentic/sandbox-contract/schemas/s2s";
import { opt } from "../../opt.js";
import { mayUse, type S2sAsker } from "../askers.js";
import type { ContactsStore } from "../contacts/contacts-store.js";
import { personOf, type S2sOutbox, type Settled } from "./outbox.js";
import { attachmentsOf, type StoredFile, type ThreadsStore } from "./threads-store.js";

// SENDING A MESSAGE (docs/architecture/messages.md, "Sending"): a person in the editor, or an agent through `messages send`
// with its turn proof, over a contact they may use. The message is filed in its thread at once, `queued`, its files
// staged with the outbox entry, and the answer goes back before any attempt; the outbox's attempts move its delivery to
// `sent` or `undelivered` (deliveryOf, below). A turn's send has already passed the owner's action rules at the route.

export interface SendDeps {
    readonly contacts: Pick<ContactsStore, "get">;
    readonly threads: ThreadsStore;
    readonly outbox: Pick<S2sOutbox, "enqueue">;
    readonly now: () => number;
    readonly random?: RandomBytes;
}

export interface SendRefusal {
    readonly error: string;
    readonly status: 400 | 404;
}

const TOO_MUCH = `a message carries at most ${S2S_MESSAGE_BYTES_MAX / 1024 / 1024} MB of files`;

const filesOf = (input: S2sMessageSend): readonly StoredFile[] | SendRefusal => {
    const files = input.files.map((file) => ({ name: file.name, bytes: Buffer.from(file.data, "base64") }));
    if (new Set(files.map((file) => file.name)).size !== files.length) {
        return { error: "two files share a name", status: 400 };
    }
    return files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > S2S_MESSAGE_BYTES_MAX ? { error: TOO_MUCH, status: 400 } : files;
};

/** Files one message in its thread and the outbox, or answers why not. */
export const sendMessage = async (deps: SendDeps, asker: S2sAsker, input: S2sMessageSend): Promise<S2sMessageSendOutcome | SendRefusal> => {
    const row = await deps.contacts.get(input.to);
    if (row === undefined || !mayUse(asker, row.scope)) {
        return { error: `no contact ${input.to} you may send to here: \`messages contacts\` lists them`, status: 404 };
    }
    if (row.state === "blocked" || row.state === "pending-in") {
        return { state: "refused", reason: row.state === "blocked" ? `${row.address} is blocked here` : `${row.address} asked to be a contact: accept it first` };
    }
    const files = filesOf(input);
    if ("error" in files) {
        return files;
    }
    const thread = input.thread === undefined ? undefined : await deps.threads.get(input.thread);
    if (input.thread !== undefined && thread?.contact !== row.id) {
        return { error: `no thread ${input.thread} with ${row.address} here`, status: 404 };
    }
    const sentAt = deps.now();
    const id = uuidv7(sentAt, deps.random);
    const filed = await deps.threads.file(
        { contact: row.id, thread: thread?.id },
        {
            id,
            direction: "out",
            kind: "message",
            ...opt("subject", input.subject),
            text: input.text,
            attachments: attachmentsOf(files),
            ...opt("as", personOf(row)),
            ...opt("replyTo", input.replyTo),
            sentAt,
            read: true,
            delivery: { state: "queued", attempts: 0 },
        },
        files,
    );
    if (filed.kind !== "filed") {
        return { state: "refused", reason: filed.reason };
    }
    const queued = await deps.outbox.enqueue({
        id,
        contact: row,
        payload: { kind: "message", ...opt("subject", input.subject), text: input.text, attachments: [] },
        thread: filed.wire,
        replyTo: input.replyTo,
        files,
    });
    if ("refused" in queued) {
        await deps.threads.changeMessage(filed.thread, id, (held) => ({ ...held, delivery: { state: "undelivered", attempts: 0, reason: queued.refused } }));
        return { state: "refused", reason: queued.refused };
    }
    return { state: "queued", id, thread: filed.thread };
};

/** A sent message's delivery as its thread shows it, from what the outbox's attempt came to. */
export const deliveryOf = (settled: Settled): { readonly state: "queued" | "sent" | "undelivered"; readonly attempts: number; readonly reason?: string } =>
    settled.state === "sent" ? { state: "sent", attempts: settled.attempts } : { state: settled.state, attempts: settled.attempts, reason: settled.reason.slice(0, 500) };
