import { S2S_MESSAGE_BYTES_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import type { ContactRow } from "../contacts/contacts-store.js";
import type { S2sHearing } from "../heard.js";
import type { S2sKindOutcome, S2sKinds, S2sReceived } from "./kinds.js";
import { attachmentsOf, type StoredFile, type ThreadsStore } from "./threads-store.js";
import { opt } from "../../opt.js";

// A MESSAGE AND ITS RECEIPT, received (docs/architecture/messages.md, "The inbox"): a message is filed into the contact's
// thread its envelope names, its files beside it, unread, and then heard by automations; a receipt marks a sent message as
// read over there.

type Decoded = { readonly ok: true; readonly files: readonly StoredFile[] } | { readonly ok: false; readonly error: string };

// A message's files decoded, within the drops' limits, each name once.
const decoded = (attachments: S2sReceived<"message">["payload"]["attachments"]): Decoded => {
    const files = attachments.map((file) => ({ name: file.name, bytes: Buffer.from(file.data, "base64") }));
    if (new Set(files.map((file) => file.name)).size !== files.length) {
        return { ok: false, error: "two files share a name" };
    }
    const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    return total > S2S_MESSAGE_BYTES_MAX ? { ok: false, error: `a message carries at most ${S2S_MESSAGE_BYTES_MAX / 1024 / 1024} MB of files` } : { ok: true, files };
};

const message = async (threads: ThreadsStore, row: ContactRow, received: S2sReceived<"message">, heard: S2sHearing): Promise<S2sKindOutcome> => {
    const { header, payload, receivedAt } = received;
    const files = decoded(payload.attachments);
    if (!files.ok) {
        return { refused: "malformed", error: files.error };
    }
    const filed = await threads.file(
        { contact: row.id, wire: header.thread ?? header.id },
        {
            id: header.id,
            direction: "in",
            kind: "message",
            ...opt("subject", payload.subject),
            text: payload.text,
            attachments: attachmentsOf(files.files),
            ...opt("as", header.as),
            ...opt("replyTo", header.replyTo),
            sentAt: header.sentAt,
            receivedAt,
            read: false,
        },
        files.files,
    );
    if (filed.kind !== "filed") {
        return filed.kind === "full" ? { refused: "rate", error: filed.reason } : { refused: "malformed", error: filed.reason };
    }
    const event = {
        event: "message",
        contact: row,
        thread: filed.thread,
        envelope: header.id,
        subject: payload.subject,
        text: payload.text,
        attachments: files.files.map((file) => file.name),
        at: receivedAt,
    } as const;
    return { stored: true, after: async () => heard(event) };
};

const receipt = async (threads: ThreadsStore, row: ContactRow, received: S2sReceived<"receipt">): Promise<S2sKindOutcome> => {
    const { payload } = received;
    const thread = await threads.ofMessage(payload.of);
    if (thread?.contact === row.id && payload.read) {
        await threads.changeMessage(thread.id, payload.of, (held) => (held.direction === "out" ? { ...held, theyReadAt: payload.at } : held));
    }
    return { stored: true };
};

/** Registers `message` and `receipt` with the inbox. */
export const registerMessageKinds = (threads: ThreadsStore, kinds: Pick<S2sKinds, "register">, heard: S2sHearing): void => {
    kinds.register("message", async (received) =>
        received.contact === undefined ? { refused: "not_contact", error: "only a contact sends messages" } : message(threads, received.contact, received, heard),
    );
    kinds.register("receipt", async (received) =>
        received.contact === undefined ? { refused: "not_contact", error: "only a contact sends receipts" } : receipt(threads, received.contact, received),
    );
};
