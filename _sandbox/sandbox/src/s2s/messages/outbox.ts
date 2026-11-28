import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyedLock } from "@intentic/base/async";
import { parseJsonOr } from "@intentic/base/json";
import { type RandomBytes, sealEnvelope, uuidv7 } from "@intentic/sandbox-contract/s2s";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import {
    S2S_WAKE_QUERY,
    S2sAddressSchema,
    type S2sEnvelope,
    S2sEnvelopeIdSchema,
    type S2sPayload,
    S2sPayloadSchema,
    S2sPersonSchema,
    S2sRefSchema,
    SandboxIdentitySchema,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import { z } from "zod";
import { opt } from "../../opt.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDirectory } from "../../store/open-document.js";
import type { JsonDir } from "../../store/plain-files/json-dir.js";
import type { ContactRow, ContactsStore } from "../contacts/contacts-store.js";
import type { WakeSecrets } from "../contacts/s2s-secrets.js";
import type { S2sIdentity } from "../identity/s2s-identity.js";
import { type Attempted, expired, verdictOf } from "./outbox-rules.js";

// THE ONE OUTBOX (docs/architecture/messages.md, "Sending" and "The outbox"): everything this sandbox sends another one,
// a message, a contact's handshake and updates, a rotation notice, waits here, one file per entry
// (`s2s-outbox/<envelope id>.json`), a message's files staged beside it (`s2s-outbox-staged/<id>/`), until the far side
// takes it. Sealed afresh at every attempt with this sandbox's current key and the recipient's currently pinned one, so a
// rotation on either side between attempts still delivers; the envelope id stays the entry's, so a retry of one already
// taken is answered as a duplicate. Retried as outbox-rules.ts says, with `?wake=` when the contact gave this sandbox its
// wake secret; held while the contact's key changed with no proof, or while it has not accepted; let go after a week, or
// at once on a refusal in words, as undelivered, which its thread then shows.

// How many entries may wait at once: a loop sending messages fills a list, never the disk.
const S2S_OUTBOX_MAX = 1000;
// An undelivered entry stays listed this long, so a person sees why, then goes.
const UNDELIVERED_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
// A held entry (a key to trust, an accept to wait for) is looked at again this often; trusting or accepting kicks it.
const HOLD_RECHECK_MS = 30 * 60 * 1000;
const DELIVER_TIMEOUT_MS = 60_000;

// The kinds that go to a contact not accepted yet: the handshake itself and its bookkeeping.
const HANDSHAKE_KINDS: ReadonlySet<string> = new Set(["contact.request", "contact.accept", "contact.update", "contact.remove", "identity.rotated"]);

const RecipientSchema = z.object({
    address: S2sAddressSchema,
    document: SandboxIdentitySchema,
    as: S2sPersonSchema.optional(),
});
export type OutboxRecipient = z.infer<typeof RecipientSchema>;

const OutboxEntrySchema = z.object({
    contact: S2sRefSchema,
    // Who it goes to as it was when filed: a removal still reaches a contact whose row is already gone.
    recipient: RecipientSchema,
    // The payload, a message's files aside (`staged`); documents and wake secrets are filled in afresh at each seal.
    payload: S2sPayloadSchema,
    thread: S2sRefSchema.optional().describe("The thread's id on the wire."),
    replyTo: S2sEnvelopeIdSchema.optional(),
    hops: z.number().int().min(0).max(10),
    staged: z.array(z.string()).optional(),
    state: z.enum(["waiting", "undelivered"]),
    firstAt: z.number().int(),
    attempts: z.number().int().min(0),
    nextAt: z.number().int(),
    lastError: z.string().max(500).optional(),
    endedAt: z.number().int().optional(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema> & { readonly id: string };

export const s2sOutboxDocument = defineDocument({
    root: "history",
    path: "s2s-outbox/",
    // Undelivered sends are the sandbox's word to its contacts: a moved sandbox still sends what it owed.
    portability: "carry",
    directory: true,
    schema: OutboxEntrySchema,
});

// What an entry came to, as its thread shows it.
export type Settled =
    | { readonly state: "sent"; readonly attempts: number }
    | { readonly state: "queued"; readonly attempts: number; readonly reason: string }
    | { readonly state: "undelivered"; readonly attempts: number; readonly reason: string };

// What a sender hands the outbox.
export interface OutboxDraft {
    readonly contact: ContactRow;
    readonly payload: S2sPayload;
    readonly thread?: string | undefined;
    readonly replyTo?: string | undefined;
    readonly hops?: number;
    readonly files?: readonly { readonly name: string; readonly bytes: Buffer }[];
    // The envelope id, when the sender minted it (a message's, which its thread already lists).
    readonly id?: string;
}

export interface OutboxDeps {
    readonly historyRoot: string;
    readonly contacts: Pick<ContactsStore, "get" | "list">;
    readonly secrets: Pick<WakeSecrets, "theirs" | "inbound">;
    readonly identity: () => S2sIdentity;
    // The base URL a sandbox host answers on.
    readonly urlOf: (host: string) => string;
    readonly fetch: S2sFetch;
    // Why a host is no address to post to (s2s-wiring.ts hostProblem), or undefined.
    readonly hostProblem: (host: string) => string | undefined;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly random?: RandomBytes;
}

// One HTTP request to another sandbox: the daemon's fetch, or a test's.
export type S2sFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface S2sOutbox {
    // Files a send and tries it at once in the background; answers its envelope id, or why it was not filed.
    readonly enqueue: (draft: OutboxDraft) => Promise<{ readonly id: string } | { readonly refused: string }>;
    // Tries every entry that is due, oldest first.
    readonly drain: () => Promise<void>;
    // Makes every waiting entry to a contact due now and drains: after its accept, or a key trusted.
    readonly kickContact: (contactId: string) => Promise<void>;
    readonly list: () => Promise<readonly OutboxEntry[]>;
    // Told what each attempt came to, for the entry's thread.
    readonly onSettled: (listener: (entry: OutboxEntry, settled: Settled) => Promise<void>) => void;
}

// A person-scoped contact's person, which rides the envelope as `as`.
export const personOf = (row: Pick<ContactRow, "scope">): string | undefined => (row.scope.kind === "person" ? row.scope.person : undefined);

const recipientOf = (row: ContactRow): OutboxRecipient => ({ address: row.address, document: row.document, ...opt("as", personOf(row)) });

// Why an entry waits rather than goes now, or is let go, by its contact's state; undefined goes.
type Standing = { readonly hold: string } | { readonly end: string } | undefined;
const standingOf = (row: ContactRow | undefined, entry: OutboxEntry): Standing => {
    if (row === undefined) {
        return entry.payload.kind === "contact.remove" ? undefined : { end: "it is no longer a contact here" };
    }
    if (row.state === "blocked") {
        return { end: "it is blocked here" };
    }
    if (row.state === "key-changed") {
        return { hold: "its key changed with no proof: trust the new one on the Messages tab first" };
    }
    if (row.state !== "accepted" && !HANDSHAKE_KINDS.has(entry.payload.kind)) {
        return { hold: row.state === "pending-out" ? "waiting for it to accept this sandbox as a contact" : "accept it as a contact first" };
    }
    return undefined;
};

const AnswerSchema = z.object({ error: z.string().optional(), code: z.string().optional() });

const post = async (deps: Pick<OutboxDeps, "fetch">, url: string, envelope: S2sEnvelope): Promise<Attempted> => {
    try {
        const response = await deps.fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(envelope),
            redirect: "error",
            signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
        });
        const answer = AnswerSchema.safeParse(parseJsonOr(await response.text(), undefined)).data;
        return { status: response.status, retryAfter: response.headers.get("retry-after") ?? undefined, error: answer?.error, code: answer?.code };
    } catch {
        // allow(silent-catch): a sandbox that does not answer at all is the commonest case here, said as status 0.
        return { status: 0, error: "it did not answer" };
    }
};

type OutboxDir = JsonDir<z.infer<typeof OutboxEntrySchema>>;
type Listener = (entry: OutboxEntry, settled: Settled) => Promise<void>;

// What every attempt works on: the entries, their staged files and who is told what each came to.
interface OutboxCore {
    readonly deps: OutboxDeps;
    readonly dir: OutboxDir;
    readonly stagedRoot: string;
    readonly listeners: Listener[];
}

const writeEntry = async (core: OutboxCore, { id, ...entry }: OutboxEntry): Promise<void> => core.dir.write(id, entry);
const unstage = async (core: OutboxCore, id: string): Promise<void> => rm(join(core.stagedRoot, id), { recursive: true, force: true });

const tell = async (core: OutboxCore, entry: OutboxEntry, settled: Settled): Promise<void> => {
    for (const listener of core.listeners) {
        await listener(entry, settled).catch((error: Error) => core.deps.logger.warn({ err: error, id: entry.id }, "s2s outbox: a settle listener failed"));
    }
};

// Let go, undelivered: listed with its reason for a while, its files gone at once.
const endEntry = async (core: OutboxCore, entry: OutboxEntry, reason: string): Promise<void> => {
    await writeEntry(core, { ...entry, state: "undelivered", lastError: reason.slice(0, 500), endedAt: core.deps.now() });
    await unstage(core, entry.id);
    core.deps.logger.warn({ id: entry.id, kind: entry.payload.kind, contact: entry.contact, reason }, "s2s outbox: not delivered");
    await tell(core, entry, { state: "undelivered", attempts: entry.attempts, reason });
};

// One attempt at one entry: held, let go, or sealed and posted, and what the answer came to written back.
const attemptOne = async (core: OutboxCore, entry: OutboxEntry): Promise<void> => {
    const { deps } = core;
    const now = deps.now();
    if (expired(entry.firstAt, now)) {
        return endEntry(core, entry, entry.lastError === undefined ? "not taken within a week" : `not taken within a week: ${entry.lastError}`);
    }
    const row = await deps.contacts.get(entry.contact);
    const standing = standingOf(row, entry);
    if (standing !== undefined) {
        return "end" in standing ? endEntry(core, entry, standing.end) : writeEntry(core, { ...entry, nextAt: now + HOLD_RECHECK_MS, lastError: standing.hold });
    }
    const recipient = row === undefined ? entry.recipient : recipientOf(row);
    const unreachable = deps.hostProblem(recipient.document.host);
    if (unreachable !== undefined) {
        return endEntry(core, entry, `${recipient.document.host} is no address this sandbox posts to: ${unreachable}`);
    }
    const envelope = await sealerFor(deps, core.stagedRoot)(entry, recipient, row);
    const secret = await deps.secrets.theirs(entry.contact);
    const query = secret === undefined ? "" : `?${S2S_WAKE_QUERY}=${encodeURIComponent(secret)}`;
    const attempts = entry.attempts + 1;
    const answer = await post(deps, `${deps.urlOf(recipient.document.host)}${rawRouteUrl("POST /s2s/inbox")}${query}`, envelope);
    const verdict = verdictOf(answer, attempts, entry.firstAt, deps.now());
    if (verdict.kind === "delivered") {
        await core.dir.remove(entry.id);
        await unstage(core, entry.id);
        return tell(core, entry, { state: "sent", attempts });
    }
    if (verdict.kind === "refused") {
        return endEntry(core, { ...entry, attempts }, verdict.reason);
    }
    await writeEntry(core, { ...entry, attempts, nextAt: verdict.at, lastError: verdict.reason.slice(0, 500) });
    await tell(core, entry, { state: "queued", attempts, reason: verdict.reason });
};

const stage = async (core: OutboxCore, id: string, files: OutboxDraft["files"]): Promise<string[] | undefined> => {
    if (files === undefined || files.length === 0) {
        return undefined;
    }
    await mkdir(join(core.stagedRoot, id), { recursive: true });
    for (const file of files) {
        await writeFile(join(core.stagedRoot, id, file.name), file.bytes);
    }
    return files.map((file) => file.name);
};

export const createS2sOutbox = (deps: OutboxDeps): S2sOutbox => {
    const { historyRoot } = deps;
    const core: OutboxCore = {
        deps,
        dir: openDirectory(s2sOutboxDocument, join(deps.historyRoot, s2sOutboxDocument.path)),
        // Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
        stagedRoot: join(historyRoot, "s2s-outbox-staged"),
        listeners: [],
    };
    const serialize = keyedLock<string>();

    // One entry, read afresh under its lock, tried when it is still waiting and due.
    const tryEntry = async (id: string, force = false): Promise<void> =>
        serialize(id, async () => {
            const entry = await core.dir.read(id);
            if (entry?.state === "waiting" && (force || entry.nextAt <= deps.now())) {
                await attemptOne(core, entry);
            }
        });

    const list = async (): Promise<readonly OutboxEntry[]> => (await core.dir.list()).entries.toSorted((a, b) => a.id.localeCompare(b.id));

    return {
        enqueue: async (draft) => {
            if ((await list()).filter((entry) => entry.state === "waiting").length >= S2S_OUTBOX_MAX) {
                return { refused: `${S2S_OUTBOX_MAX} sends already wait to be delivered: let those land first` };
            }
            const now = deps.now();
            const id = draft.id ?? uuidv7(now, deps.random);
            const staged = await stage(core, id, draft.files);
            await writeEntry(core, {
                id,
                contact: draft.contact.id,
                recipient: recipientOf(draft.contact),
                payload: draft.payload,
                ...opt("thread", draft.thread),
                ...opt("replyTo", draft.replyTo),
                hops: draft.hops ?? 0,
                ...opt("staged", staged),
                state: "waiting",
                firstAt: now,
                attempts: 0,
                nextAt: now,
            });
            void tryEntry(id, true).catch((error: Error) => deps.logger.warn({ err: error, id }, "s2s outbox: an attempt failed"));
            return { id };
        },
        drain: async () => {
            const now = deps.now();
            for (const entry of await list()) {
                if (entry.state === "undelivered" && now - (entry.endedAt ?? entry.firstAt) > UNDELIVERED_KEPT_MS) {
                    await core.dir.remove(entry.id);
                } else if (entry.state === "waiting" && entry.nextAt <= now) {
                    await tryEntry(entry.id);
                }
            }
        },
        kickContact: async (contactId) => {
            for (const entry of await list()) {
                if (entry.contact === contactId && entry.state === "waiting") {
                    await tryEntry(entry.id, true);
                }
            }
        },
        list,
        onSettled: (listener) => {
            core.listeners.push(listener);
        },
    };
};

// The envelope for one attempt: the payload freshened (this sandbox's current document where it carries one, its current
// wake secret where it hands one over, a message's staged files read back) and sealed now.
const sealerFor =
    (deps: OutboxDeps, stagedRoot: string) =>
    async (entry: OutboxEntry, recipient: OutboxRecipient, row: ContactRow | undefined): Promise<S2sEnvelope> => {
        const identity = deps.identity();
        const [sender, document] = await Promise.all([identity.current(), identity.document()]);
        const wake = row?.grants.wake === true ? await deps.secrets.inbound() : undefined;
        const payload = await freshened(entry, document, wake, stagedRoot);
        return sealEnvelope({
            addressing: {
                id: entry.id,
                from: document.host,
                to: recipient.address,
                kind: payload.kind,
                thread: entry.thread,
                replyTo: entry.replyTo,
                as: recipient.as,
                hops: entry.hops,
                sentAt: deps.now(),
            },
            payload,
            sender,
            recipient: recipient.document.keys,
            ...opt("random", deps.random),
        });
    };

const stagedFiles = async (stagedRoot: string, id: string, names: readonly string[]): Promise<{ name: string; data: string }[]> =>
    Promise.all(names.map(async (name) => ({ name, data: (await readFile(join(stagedRoot, id, name))).toString("base64") })));

const freshened = async (
    entry: OutboxEntry,
    document: z.infer<typeof SandboxIdentitySchema>,
    wake: string | undefined,
    stagedRoot: string,
): Promise<S2sPayload> => {
    const payload = entry.payload;
    switch (payload.kind) {
        case "contact.request":
        case "contact.accept": {
            const { wake: _held, ...rest } = payload;
            return { ...rest, document, ...opt("wake", wake) };
        }
        case "identity.rotated":
            return { ...payload, document };
        case "contact.update":
            // A wake secret handed over is the current one; a null (taken away) stays null.
            return payload.wake === undefined || payload.wake === null || wake === undefined ? payload : { ...payload, wake };
        case "message": {
            // allow(silent-catch): staged files gone (removed by hand) leave the words alone to send.
            const names = entry.staged ?? (await readdir(join(stagedRoot, entry.id)).catch(() => []));
            return names.length === 0 ? payload : { ...payload, attachments: await stagedFiles(stagedRoot, entry.id, names) };
        }
        default:
            return payload;
    }
};
