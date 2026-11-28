import { join } from "node:path";
import {
    type S2sContactScope,
    S2S_ENVELOPE_MAX_BYTES,
    S2sEnvelopeSchema,
    S2sMessageSendSchema,
    type S2sOutboxEntry,
    S2sTakeSchema,
    type S2sThreadMessage,
    type S2sThreadSummary,
} from "@intentic/sandbox-contract/schemas/s2s";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { opt } from "../../opt.js";
import { takeTarget } from "../../workspace/take-target.js";
import { type AskerDeps, askerOf, mayRead, mayUse, type S2sAsker } from "../askers.js";
import type { ContactRow } from "../contacts/contacts-store.js";
import type { S2s } from "../s2s-service.js";
import { askerDepsOf } from "../s2s-wiring.js";
import { type SendGuard, sendGuardOf } from "./send-guard.js";
import { sendMessage } from "./send-message.js";
import type { StoredMessage, ThreadRecord } from "./threads-store.js";

// The inbox's routes (RAW_ROUTES, schemas/s2s.ts): the door every other sandbox posts envelopes to, and what a person or a
// proven turn reads and sends: threads, a message's files and taking them into the workspace, sending, and the outbox.
// Each thread is shown to whoever may read its contact (askers.ts mayRead); one whose contact is gone, to maintainers.

const PREVIEW = 200;

// Who a thread is with, as the inbox shows and cuts it: its contact, or the sender from before contacts the thread itself
// names (threads-store.ts LegacySender), shown like a person-scoped contact to that person.
interface Party {
    readonly name: string;
    readonly scope: S2sContactScope;
}

const contactParty = (row: ContactRow | undefined): Party | undefined => (row === undefined ? undefined : { name: row.name ?? row.document.name, scope: row.scope });

const partyOf = (thread: ThreadRecord, row: ContactRow | undefined): Party | undefined =>
    contactParty(row) ?? (thread.legacy === undefined ? undefined : { name: thread.legacy.sandboxName, scope: { kind: "person", person: thread.legacy.person } });

const summaryOf = (thread: ThreadRecord, party: Party | undefined): S2sThreadSummary => {
    const last = thread.messages.at(-1);
    return {
        id: thread.id,
        contact: thread.contact,
        contactName: party?.name ?? thread.contact,
        scope: party?.scope ?? { kind: "sandbox" },
        ...opt("subject", thread.subject),
        last: { at: last?.receivedAt ?? last?.sentAt ?? thread.createdAt, direction: last?.direction ?? "in", preview: (last?.text ?? "").replace(/\s+/gu, " ").slice(0, PREVIEW) },
        unread: thread.messages.filter((message) => message.direction === "in" && !message.read).length,
        messages: thread.messages.length,
        undelivered: thread.messages.filter((message) => message.delivery?.state === "undelivered").length,
    };
};

const messageOf = (thread: ThreadRecord, { theyReadAt: _read, ...message }: StoredMessage): S2sThreadMessage => ({ ...message, thread: thread.id, contact: thread.contact });

const readable = (asker: S2sAsker, party: Party | undefined): boolean => (party === undefined ? asker.kind === "person" && asker.maintainer : mayRead(asker, party.scope));

export interface MessagesRouteDeps {
    readonly askers: AskerDeps;
    readonly guard: SendGuard;
    readonly take: Pick<Services, "workspace" | "areas" | "files">;
}

export const messagesRoutesOf = (s2s: S2s, deps: MessagesRouteDeps) => {
    const rowsById = async (): Promise<ReadonlyMap<string, ContactRow>> => new Map((await s2s.contacts.list()).map((row) => [row.id, row]));

    // The thread the path names (or the message's thread), when this asker reads it; the same 404 as for none at all.
    const shown = async (c: Context<AppEnv>, thread: ThreadRecord | undefined, what: string): Promise<ThreadRecord | Response> => {
        const row = thread === undefined ? undefined : await s2s.contacts.get(thread.contact);
        return thread !== undefined && readable(await askerOf(deps.askers, c), partyOf(thread, row)) ? thread : c.json({ error: `no ${what} here for you: \`messages\` lists them` }, 404);
    };
    const threadParam = async (c: Context<AppEnv>) => shown(c, await s2s.threads.get(c.req.param("id") ?? ""), `thread ${c.req.param("id") ?? ""}`);
    const messageParam = async (c: Context<AppEnv>) => shown(c, await s2s.threads.ofMessage(c.req.param("id") ?? ""), `message ${c.req.param("id") ?? ""}`);

    return {
        "POST /s2s/inbox": async (c: Context<AppEnv>) => {
            const read = await readBoundedJson(c.req.raw, S2S_ENVELOPE_MAX_BYTES);
            if (read.kind === "tooLarge") {
                return c.json({ error: `an envelope is at most ${S2S_ENVELOPE_MAX_BYTES} bytes`, code: "too_large" }, 413);
            }
            const envelope = read.kind === "ok" ? S2sEnvelopeSchema.safeParse(read.value) : undefined;
            if (envelope?.success !== true) {
                return c.json({ error: "not an envelope (S2sEnvelopeSchema)", code: "malformed" }, 400);
            }
            const answer = await s2s.receive(envelope.data);
            // Handed on once the sender has its answer; the service logs what fails in it.
            if ("after" in answer && answer.after !== undefined) {
                void answer.after();
            }
            return c.json(answer.body, answer.status);
        },
        "GET /s2s/threads": async (c: Context<AppEnv>) => {
            const [asker, rows, threads] = await Promise.all([askerOf(deps.askers, c), rowsById(), s2s.threads.list()]);
            const parties = new Map(threads.map((thread) => [thread.id, partyOf(thread, rows.get(thread.contact))]));
            const shownThreads = threads.filter((thread) => readable(asker, parties.get(thread.id))).map((thread) => summaryOf(thread, parties.get(thread.id)));
            const requests = [...rows.values()].filter((row) => row.state === "pending-in" && mayUse(asker, row.scope)).length;
            return c.json({ threads: shownThreads.toSorted((a, b) => b.last.at - a.last.at), requests });
        },
        "GET /s2s/threads/{id}": async (c: Context<AppEnv>) => {
            const thread = await threadParam(c);
            return thread instanceof Response
                ? thread
                : c.json({ thread: summaryOf(thread, partyOf(thread, await s2s.contacts.get(thread.contact))), messages: thread.messages.map((message) => messageOf(thread, message)) });
        },
        "DELETE /s2s/threads/{id}": async (c: Context<AppEnv>) => {
            const thread = await threadParam(c);
            if (thread instanceof Response) {
                return thread;
            }
            await s2s.threads.remove(thread.id);
            return c.json({ ok: true as const });
        },
        "POST /s2s/threads/{id}/read": async (c: Context<AppEnv>) => {
            const thread = await threadParam(c);
            if (thread instanceof Response) {
                return thread;
            }
            await s2s.read(thread.id);
            return c.json({ ok: true as const });
        },
        "GET /s2s/messages/{id}/files/{name}": async (c: Context<AppEnv>) => {
            const thread = await messageParam(c);
            const name = c.req.param("name") ?? "";
            const bytes = thread instanceof Response ? undefined : await s2s.threads.fileOf(c.req.param("id") ?? "", name);
            if (thread instanceof Response || bytes === undefined) {
                return thread instanceof Response ? thread : c.json({ error: `that message carries no file ${name}` }, 404);
            }
            return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
        },
        "POST /s2s/messages/{id}/take": async (c: Context<AppEnv>) => takeFiles(s2s, deps, c, await messageParam(c)),
        "POST /s2s/messages": async (c: Context<AppEnv>) => send(s2s, deps, c),
        "GET /s2s/outbox": async (c: Context<AppEnv>) => {
            const [asker, rows, entries] = await Promise.all([askerOf(deps.askers, c), rowsById(), s2s.outbox.list()]);
            const views = await Promise.all(
                entries.filter((entry) => readable(asker, contactParty(rows.get(entry.contact)))).map(async (entry) => outboxEntryOf(s2s, entry, rows.get(entry.contact))),
            );
            return c.json({ entries: views });
        },
    };
};

const outboxEntryOf = async (s2s: S2s, entry: Awaited<ReturnType<S2s["outbox"]["list"]>>[number], row: ContactRow | undefined): Promise<S2sOutboxEntry> => {
    const thread = entry.thread === undefined ? undefined : await s2s.threads.byWire(entry.contact, entry.thread);
    return {
        id: entry.id,
        contact: entry.contact,
        contactName: row?.name ?? row?.document.name ?? entry.recipient.document.name,
        kind: entry.payload.kind,
        ...opt("thread", thread?.id),
        state: entry.state,
        attempts: entry.attempts,
        firstAt: entry.firstAt,
        ...opt("nextAt", entry.state === "waiting" ? entry.nextAt : undefined),
        ...opt("lastError", entry.lastError),
    };
};

const send = async (s2s: S2s, deps: MessagesRouteDeps, c: Context<AppEnv>): Promise<Response> => {
    const asker = await askerOf(deps.askers, c);
    if (asker.kind === "nobody") {
        return c.json({ error: "a message is sent by a person signed in, or by a turn that proves which conversation it is" }, 403);
    }
    const read = await readBoundedJson(c.req.raw, S2S_ENVELOPE_MAX_BYTES);
    const input = read.kind === "ok" ? S2sMessageSendSchema.safeParse(read.value) : undefined;
    if (input?.success !== true) {
        return c.json({ error: read.kind === "tooLarge" ? "a message carries at most 10 MB of files" : "a message names its contact and carries text: {to, text, subject?, thread?, files?}" }, read.kind === "tooLarge" ? 413 : 400);
    }
    const row = await s2s.contacts.get(input.data.to);
    const legacy = row === undefined ? await legacyRefusal(s2s, input.data.to) : undefined;
    if (legacy !== undefined) {
        return c.json({ state: "refused", reason: legacy });
    }
    // Only an agent's send is the guard's: a person's own, from the editor, is theirs.
    const turn = asker.kind === "turn" && row !== undefined && mayUse(asker, row.scope) ? { asker, row } : undefined;
    const refused = turn === undefined ? undefined : await deps.guard.refusal();
    if (turn !== undefined && refused !== undefined) {
        deps.guard.record(turn.asker, turn.row, input.data.text, refused);
        return c.json({ state: "refused", reason: refused });
    }
    const outcome = await sendMessage({ contacts: s2s.contacts, threads: s2s.threads, outbox: s2s.outbox, now: Date.now }, asker, input.data);
    if ("error" in outcome) {
        return c.json({ error: outcome.error }, outcome.status);
    }
    if (turn !== undefined) {
        deps.guard.record(turn.asker, turn.row, input.data.text, outcome.state === "queued" ? undefined : outcome.reason);
    }
    return c.json(outcome);
};

// A message to a sender from before contacts: it has no key to seal to, so the answer goes back the old way, as a drop.
const legacyRefusal = async (s2s: S2s, contact: string): Promise<string | undefined> => {
    const sender = (await s2s.threads.list()).find((thread) => thread.contact === contact && thread.legacy !== undefined)?.legacy;
    return sender === undefined
        ? undefined
        : `${sender.sandboxName} runs a build from before contacts, so it takes no messages: answer with \`sandboxes send ${sender.sandboxName}\` from a conversation acting for ${sender.person}, which goes there as a drop`;
};

const takeFiles = async (s2s: S2s, deps: MessagesRouteDeps, c: Context<AppEnv>, thread: ThreadRecord | Response): Promise<Response> => {
    if (thread instanceof Response) {
        return thread;
    }
    const id = c.req.param("id") ?? "";
    const message = thread.messages.find((held) => held.id === id);
    // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
    const parsed = S2sTakeSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success || message === undefined) {
        return c.json({ error: "name the folder to take it into: {dest, files?}" }, 400);
    }
    const names = message.attachments.map((file) => file.name).filter((name) => parsed.data.files?.includes(name) ?? true);
    const target = await takeTarget(deps.take, c, parsed.data.dest, names, "a message's files");
    if (target instanceof Response) {
        return target;
    }
    for (const name of names) {
        const bytes = await s2s.threads.fileOf(id, name);
        if (bytes !== undefined) {
            await deps.take.files.write(join(target, name), bytes);
        }
    }
    return c.json({ dest: parsed.data.dest, files: names });
};

export const s2sMessagesRawRoutes = defineRawRoutes(
    (services: Pick<Services, "s2s" | "agents" | "ownerEmail" | "members" | "workspace" | "areas" | "files" | "sandboxSettings" | "activity" | "logger">) =>
        messagesRoutesOf(services.s2s, { askers: askerDepsOf(services), guard: sendGuardOf(services), take: services }),
);
