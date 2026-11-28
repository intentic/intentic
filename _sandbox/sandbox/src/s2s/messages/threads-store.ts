import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { S2S_SUBJECT_MAX, type S2sAttachmentMeta, S2sPersonSchema, S2sRefSchema, S2sThreadMessageSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { z } from "zod";
import { opt } from "../../opt.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDirectory } from "../../store/open-document.js";
import type { JsonDir } from "../../store/plain-files/json-dir.js";

// THE INBOX'S THREADS (docs/architecture/messages.md, "The inbox"): one file per thread on the history volume
// (`s2s-threads/<id>.json`), received and sent messages side by side, each received one read or unread and each sent one
// with its delivery; a message's files under `s2s-files/<message>/`. A thread's id here is this sandbox's own; `wire`
// is the id both sides name it by on the envelope, filed per contact, so no contact can write into another's thread by
// naming its id. Bounded like the drops' inbox: a contact looping on messages fills its thread, never the disk. A message's
// id is the envelope's, chosen by its sender, so one already filed in another thread or the other way (a contact sending
// back the id of a message this sandbox sent it) is refused, never written over that message or its files.

// How many threads, and how many messages in one, before the next is refused (429, which the sender retries).
const S2S_THREADS_MAX = 500;
const S2S_THREAD_MESSAGES_MAX = 1000;

const StoredMessageSchema = S2sThreadMessageSchema.omit({ thread: true, contact: true }).extend({
    // When the contact said it read it (a `receipt`), for a sent one.
    theyReadAt: z.number().int().optional(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

// A sender from before contacts: a sandbox whose build drops through the account door (account-routing/messages/drop-threads.ts),
// with no key, so its thread's contact is no contact row and nothing is sent back over it. Its person is whom the
// thread is shown to, as a person-scoped contact's thread is.
const LegacySenderSchema = z.object({
    sandboxId: z.string().min(1).max(100),
    sandboxName: z.string().max(120),
    person: S2sPersonSchema,
});
export type LegacySender = z.infer<typeof LegacySenderSchema>;

const ThreadRecordSchema = z.object({
    contact: S2sRefSchema,
    wire: S2sRefSchema.describe("The id both sides name the thread by on the envelope."),
    subject: z.string().max(S2S_SUBJECT_MAX).optional(),
    messages: z.array(StoredMessageSchema),
    createdAt: z.number().int(),
    legacy: LegacySenderSchema.optional().describe("Who dropped into it through the account door, for a thread whose contact is a sender from before contacts."),
});
export type ThreadRecord = z.infer<typeof ThreadRecordSchema> & { readonly id: string };

export const s2sThreadsDocument = defineDocument({
    root: "history",
    path: "s2s-threads/",
    // What other sandboxes said to this one and what it said back: a moved sandbox still holds its conversations.
    portability: "carry",
    directory: true,
    schema: ThreadRecordSchema,
});

export interface StoredFile {
    readonly name: string;
    readonly bytes: Buffer;
}

// A message as it is filed: everything but where it belongs, which the filing names.
export type NewMessage = Omit<StoredMessage, "theyReadAt">;

// Where a message is filed: the contact's thread named, or the one `wire` names.
export interface Where {
    readonly contact: string;
    readonly thread?: string | undefined;
    readonly wire?: string | undefined;
    readonly legacy?: LegacySender | undefined;
}

export type Filed = { readonly kind: "filed"; readonly thread: string; readonly wire: string } | { readonly kind: "full" | "taken"; readonly reason: string };

export interface ThreadsStore {
    readonly list: () => Promise<readonly ThreadRecord[]>;
    readonly get: (id: string) => Promise<ThreadRecord | undefined>;
    // Files a message into the contact's thread `wire` names (a new one when it names none, or one not seen yet), its
    // files beside it; refused when the inbox or the thread is full. `legacy` names a sender from before contacts.
    readonly file: (where: Where, message: NewMessage, files: readonly StoredFile[]) => Promise<Filed>;
    // Changes one message of a thread; false when either is gone.
    readonly changeMessage: (thread: string, message: string, change: (held: StoredMessage) => StoredMessage) => Promise<boolean>;
    // Marks every received message read, answering the newest that was not.
    readonly markRead: (thread: string) => Promise<StoredMessage | undefined>;
    // The contact's thread `wire` names, when there is one.
    readonly byWire: (contact: string, wire: string) => Promise<ThreadRecord | undefined>;
    // The thread a message is in, by the message's id.
    readonly ofMessage: (message: string) => Promise<ThreadRecord | undefined>;
    // A message's file whole, by name.
    readonly fileOf: (message: string, name: string) => Promise<Buffer | undefined>;
    readonly remove: (thread: string) => Promise<boolean>;
}

// A thread id this side mints: a file name the directory takes.
const mintThreadId = (): string => `t-${randomUUID().replaceAll("-", "")}`;
const ENTRY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/u;

// A file's own name, never a path.
const ownName = (name: string): boolean => !/[/\\\0]/u.test(name) && name !== "." && name !== "..";

type ThreadsDir = JsonDir<z.infer<typeof ThreadRecordSchema>>;

// Every received message of a thread marked read; the newest that was not, or undefined when none was unread.
const readAll = async (dir: ThreadsDir, held: ThreadRecord | undefined): Promise<StoredMessage | undefined> => {
    const unread = held?.messages.filter((message) => message.direction === "in" && !message.read) ?? [];
    if (held === undefined || unread.length === 0) {
        return undefined;
    }
    const { id: _id, ...record } = held;
    await dir.write(held.id, { ...record, messages: held.messages.map((message) => (message.direction === "in" ? { ...message, read: true } : message)) });
    return unread.at(-1);
};

// A message's files, written aside and renamed into place, so a crash leaves no half a message's files.
const writeFilesAside = async (filesRoot: string, target: string | undefined, message: string, files: readonly StoredFile[]): Promise<void> => {
    if (target === undefined || files.length === 0) {
        return;
    }
    const partial = join(filesRoot, `.partial-${message}`);
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const file of files) {
        await writeFile(join(partial, file.name), file.bytes);
    }
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
};

// The thread a message's id is filed in.
const holderOf = (threads: readonly ThreadRecord[], message: string): ThreadRecord | undefined => threads.find((thread) => thread.messages.some((held) => held.id === message));

// Why a message's id cannot be filed where asked: another contact's thread, or a message the other way, holds it.
const takenIn = (threads: readonly ThreadRecord[], where: Where, message: NewMessage): string | undefined => {
    const holder = holderOf(threads, message.id);
    const held = holder?.messages.find((other) => other.id === message.id);
    return holder === undefined || (holder.contact === where.contact && held?.direction === message.direction)
        ? undefined
        : `a message ${message.id} is already filed here: an envelope's id is never reused`;
};

export const fileThreadsStore = (historyRoot: string): ThreadsStore => {
    const dir = openDirectory(s2sThreadsDocument, join(historyRoot, s2sThreadsDocument.path));
    // Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
    const filesRoot = join(historyRoot, "s2s-files");
    const serialize = keyedLock<string>();
    const filesDir = (message: string): string | undefined => (ENTRY_ID.test(message) ? join(filesRoot, message) : undefined);

    const list = async (): Promise<readonly ThreadRecord[]> => (await dir.list()).entries;
    const get = async (id: string): Promise<ThreadRecord | undefined> => (ENTRY_ID.test(id) ? dir.read(id) : undefined);
    const byWire = async (contact: string, wire: string): Promise<ThreadRecord | undefined> =>
        (await list()).find((thread) => thread.contact === contact && thread.wire === wire);

    const writeFiles = async (message: string, files: readonly StoredFile[]): Promise<void> => writeFilesAside(filesRoot, filesDir(message), message, files);

    // The thread a filing lands in: the one named, the contact's thread for `wire`, or a new one.
    const placeOf = async (where: Where): Promise<{ readonly id: string; readonly held?: ThreadRecord } | { readonly full: string }> => {
        const named = where.thread === undefined ? undefined : await get(where.thread);
        const held = named?.contact === where.contact ? named : where.wire === undefined ? undefined : await byWire(where.contact, where.wire);
        if (held !== undefined) {
            return held.messages.length >= S2S_THREAD_MESSAGES_MAX ? { full: `this thread already holds ${S2S_THREAD_MESSAGES_MAX} messages: start another` } : { id: held.id, held };
        }
        if ((await list()).length >= S2S_THREADS_MAX) {
            return { full: `this sandbox's inbox already holds ${S2S_THREADS_MAX} threads: its people delete what is dealt with first` };
        }
        return { id: mintThreadId() };
    };

    const ofMessage = async (message: string): Promise<ThreadRecord | undefined> => holderOf(await list(), message);

    const file: ThreadsStore["file"] = async (where, message, files) =>
        serialize(`contact:${where.contact}`, async () => {
            const taken = takenIn(await list(), where, message);
            if (taken !== undefined) {
                return { kind: "taken", reason: taken };
            }
            const place = await placeOf(where);
            if ("full" in place) {
                return { kind: "full", reason: place.full };
            }
            await writeFiles(message.id, files);
            const held = place.held;
            const wire = held?.wire ?? where.wire ?? place.id;
            const subject = held?.subject ?? message.subject;
            const messages = [...(held?.messages ?? []).filter((other) => other.id !== message.id), message].toSorted((a, b) => a.sentAt - b.sentAt);
            const legacy = where.legacy ?? held?.legacy;
            await dir.write(place.id, { contact: where.contact, wire, ...opt("subject", subject), messages, createdAt: held?.createdAt ?? message.sentAt, ...opt("legacy", legacy) });
            return { kind: "filed", thread: place.id, wire };
        });

    const changeMessage: ThreadsStore["changeMessage"] = async (thread, message, change) =>
        serialize(`thread:${thread}`, async () => {
            const held = await get(thread);
            if (held === undefined || !held.messages.some((other) => other.id === message)) {
                return false;
            }
            const { id: _id, ...record } = held;
            await dir.write(thread, { ...record, messages: held.messages.map((other) => (other.id === message ? change(other) : other)) });
            return true;
        });

    return {
        list,
        get,
        file,
        changeMessage,
        byWire,
        markRead: async (thread) => serialize(`thread:${thread}`, async () => readAll(dir, await get(thread))),
        ofMessage,
        fileOf: async (message, name) => {
            const target = filesDir(message);
            // allow(silent-catch): a file that is not there reads as none, which the route answers 404.
            return target === undefined || !ownName(name) ? undefined : readFile(join(target, name)).catch(() => undefined);
        },
        remove: async (thread) => {
            const held = await get(thread);
            if (held === undefined) {
                return false;
            }
            await dir.remove(thread);
            for (const target of held.messages.map((message) => filesDir(message.id))) {
                if (target !== undefined) {
                    await rm(target, { recursive: true, force: true });
                }
            }
            return true;
        },
    };
};

/** A message's files as the thread lists them. */
export const attachmentsOf = (files: readonly StoredFile[]): S2sAttachmentMeta[] => files.map((file) => ({ name: file.name, size: file.bytes.byteLength }));
