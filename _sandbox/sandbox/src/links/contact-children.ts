import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { LinkTask, LinkTaskStatus } from "@intentic/sandbox-contract/schemas/links";
import type { S2sPayload } from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import type { ChildActionResult, ChildSpawnResult } from "../agent/subagents/children.js";
import { opt } from "../opt.js";
import { contactServerName } from "../s2s/contacts/contact-mounts.js";
import type { ContactRow } from "../s2s/contacts/contacts-store.js";
import { askedOf, type AskedChild, type Live, type StoredChild } from "./linked-children-store.js";
import { type Destination, isLinkCard, type LinkCard } from "./linked-destinations.js";

/* A TASK HANDED TO A CONTACT (2026-11-27, docs/architecture/messages.md "Tasks"): the asking side of `task.*` messages,
 * beside a link's follower (linked-children.ts), on the same roster records. What differs from a link:
 * - nothing is long-polled: the far side pushes `task.update` messages, which move the record (`heard`), and the parent is
 *   woken by the same settle a follower's ending makes;
 * - every call is a message in the one outbox: a hand-over, a follow-up, an answer or a stop waits for its first attempt
 *   (a few seconds), so a refusal in words comes back to the agent at once, and one the far side does not answer yet is
 *   delivered when it does, for a week. A refusal heard after that settles the task (a request) or is said on its row;
 * - the far side's conversation is unknown until its first update names it. */

// How long a call waits for its message's first attempt before answering that it is queued.
const FIRST_ATTEMPT_MS = 8_000;

// What a message's first attempt came to: taken over there, refused in words, or not answered yet (kept and retried).
export type Delivery = { readonly state: "sent" } | { readonly state: "refused"; readonly reason: string } | { readonly state: "waiting"; readonly reason?: string | undefined };

// The asking side's reach into contacts and the outbox (s2s/tasks/asking.ts), injectable so a suite stands two daemons up.
export interface ContactSends {
    // The accepted contacts a conversation may use: sandbox-scoped ones for a turn acting for a maintainer, a person-scoped
    // one for a turn acting for that one person.
    readonly usable: (conversationId: string) => Promise<readonly ContactRow[]>;
    readonly get: (contactId: string) => Promise<ContactRow | undefined>;
    // One `task.*` message into the outbox, its first attempt waited on for at most `waitMs`.
    readonly send: (contact: ContactRow, payload: S2sPayload, options: { readonly hops?: number; readonly waitMs: number }) => Promise<Delivery>;
    // Whether the outbox still holds this task's request: a restart between filing and sending asks only when it does not.
    readonly requestQueued: (contactId: string, requestId: string) => Promise<boolean>;
}

/** Runs one contact step when this sandbox reaches contacts at all; a failure is logged, never thrown. */
export const withContact = async (engine: ContactEngine | undefined, act: (engine: ContactEngine) => Promise<void>): Promise<void> => {
    await (engine === undefined ? undefined : act(engine).catch((error: Error) => engine.logger.warn({ err: error }, "contact task: a step failed")));
};

const nameOf = (row: ContactRow): string => row.name ?? row.document.name;

// The contacts a conversation may use that say they give this sandbox tasks.
const givingTasks = async (sends: ContactSends, conversationId: string): Promise<readonly ContactRow[]> =>
    (await sends.usable(conversationId)).filter((row) => row.theirGrants?.task !== undefined);

type Refused = Extract<Destination, { readonly refused: string }>;

// Whether a link card answers to a name, other than one for the very sandbox the contact is (the pairing that made both).
const cardClashes = (card: LinkCard, wanted: string, rows: readonly ContactRow[]): boolean =>
    [card.id, card.config.name].some((name) => name?.toLowerCase() === wanted) &&
    !(card.config.sandboxId !== undefined && rows.every((row) => row.vouchedSandbox === card.config.sandboxId));

/**
 * The contact `to` names among those a conversation may use. Exactly: its id, or its address. By a bare name (its name,
 * or its server's name) only while the name is no one else's: when it also names a contact of another sandbox (another
 * key), or a link card, the hand-over is refused as ambiguous, so no contact can name itself into another's place. Among
 * one sandbox's contacts, a hand-over as the person takes their own before the sandbox's. Undefined for none, which falls
 * back to a person route and the link cards.
 */
const contactNamed = async (
    sends: ContactSends,
    cards: () => Promise<readonly LinkCard[]>,
    conversationId: string,
    to: string,
    prefer: "sandbox" | "person",
): Promise<ContactRow | Refused | undefined> => {
    const wanted = to.trim().toLowerCase();
    const preferred = (rows: readonly ContactRow[]): ContactRow | undefined => rows.find((row) => row.scope.kind === prefer) ?? rows[0];
    const giving = await givingTasks(sends, conversationId);
    const exact = giving.filter((row) => row.id === to.trim() || row.address === wanted);
    if (exact.length > 0) {
        return preferred(exact);
    }
    const answers = (row: ContactRow): boolean => nameOf(row).toLowerCase() === wanted || contactServerName(row) === wanted;
    const named = giving.filter(answers);
    if (named.length === 0) {
        return undefined;
    }
    const others = (await sends.usable(conversationId)).filter((row) => answers(row) && !named.some((one) => one.document.fingerprint === row.document.fingerprint));
    const keys = new Set(named.map((row) => row.document.fingerprint));
    const clashing = (await cards()).filter((card) => cardClashes(card, wanted, named));
    if (keys.size > 1 || others.length > 0 || clashing.length > 0) {
        const candidates = [...new Set([...named, ...others].map((row) => `${nameOf(row)} (${row.address})`)), ...clashing.map((card) => `link card "${card.id}"`)];
        return {
            refused: `"${to}" names more than one sandbox this conversation may hand work to: ${candidates.join(", ")}. Name the contact by its address or id (\`messages contacts\` lists them), or the link card by its id with \`via\`.`,
        };
    }
    return preferred(named);
};

// What the contact engine needs of the linked children's own (linked-children.ts), handed in so neither imports the other.
export interface ContactEngine {
    readonly sends: ContactSends;
    readonly live: Map<string, Live>;
    readonly put: (child: StoredChild) => Promise<void>;
    readonly drop: (id: string) => Promise<void>;
    // The roster record opened (again): `pending` until the far side says it runs.
    readonly open: (stored: AskedChild, status: "pending" | "running", again: boolean) => void;
    // One status onto the record; true once it settled.
    readonly take: (child: Live, status: LinkTaskStatus) => Promise<boolean>;
    readonly settle: (child: Live, status: "failed", report: string, error: string) => Promise<void>;
    readonly note: (childId: string, summary: string) => void;
    readonly taint: (conversationId: string) => string | undefined;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// The far side's words as the outbox kept them, its code in brackets at the end.
const refusedWords = (row: Pick<ContactRow, "name" | "document">, what: string, reason: string): string => `"${row.name ?? row.document.name}" did not take ${what}: ${reason}`;

const queuedWords = (sandbox: string, delivery: Extract<Delivery, { state: "waiting" }>): string =>
    `"${sandbox}" has not answered yet${delivery.reason === undefined ? "" : ` (${delivery.reason})`}: it is delivered when it does, for up to a week.`;

// The live record a contact task's id names, while it is a contact's.
const contactChild = (engine: ContactEngine, childId: string, contactId: string): Live | undefined => {
    const child = engine.live.get(childId);
    return child?.stored.via === "contact" && child.stored.contact === contactId ? child : undefined;
};

/**
 * Where a hand-over goes when it is a contact's: one this conversation may use, by its id (`via: "contact"`, its tool
 * server) or by a name it goes by. Undefined when no contact is named, so a person route or a link card is looked for;
 * a contact asked for by id and not usable goes nowhere.
 */
export const contactDestination = async (
    sends: ContactSends | undefined,
    capabilities: () => Promise<readonly Capability[]>,
    conversationId: string,
    ask: { readonly to: string; readonly via?: "person" | "contact" | undefined },
): Promise<{ readonly contact: ContactRow; readonly sends: ContactSends } | Refused | undefined> => {
    const cards = async (): Promise<readonly LinkCard[]> => (await capabilities()).filter(isLinkCard);
    const row =
        sends === undefined
            ? undefined
            : ask.via === "contact"
              ? (await givingTasks(sends, conversationId)).find((candidate) => candidate.id === ask.to)
              : await contactNamed(sends, cards, conversationId, ask.to, ask.via === "person" ? "person" : "sandbox");
    if (row !== undefined && "refused" in row) {
        return row;
    }
    if (row !== undefined && sends !== undefined) {
        return { contact: row, sends };
    }
    return ask.via === "contact"
        ? { refused: `No contact "${ask.to}" that gives this sandbox tasks is this conversation's to hand work to: \`messages contacts\` lists the contacts it may use.` }
        : undefined;
};

// A new hand-over as delegate files it: its roster id, its parent, the ask, and a line naming it.
export interface ContactAsk {
    readonly id: string;
    readonly parent: string;
    readonly asking: LinkTask;
    readonly description?: string | undefined;
}

/** Hands a task to a contact: filed, put on the roster, sent, and answered by its first attempt. */
export const delegateToContact = async (engine: ContactEngine, row: ContactRow, ask: ContactAsk, landingOf: (sandbox: string) => string): Promise<ChildSpawnResult> => {
    const sandbox = nameOf(row);
    const pending = {
        id: ask.id,
        parent: ask.parent,
        link: `contact:${row.id}`,
        sandbox,
        via: "contact" as const,
        contact: row.id,
        ...opt("person", row.scope.kind === "person" ? row.scope.person : undefined),
        asking: ask.asking,
        ...opt("description", ask.description),
        startedAt: Date.now(),
    };
    const landing = landingOf(sandbox);
    // Filed and live before anything is sent: the far side's first update may arrive before the first attempt is answered.
    await engine.put(pending);
    const child: Live = { stored: { ...pending, remote: "" }, last: undefined, report: undefined, following: undefined };
    engine.live.set(pending.id, child);
    const delivered = await engine.sends.send(row, { kind: "task.request", ...pending.asking }, { hops: pending.asking.hops, waitMs: FIRST_ATTEMPT_MS });
    if (delivered.state === "refused") {
        engine.live.delete(pending.id);
        await engine.drop(pending.id);
        return { ok: false, message: refusedWords(row, "the task", delivered.reason) };
    }
    // The first update may already have opened the record with the conversation over there.
    if (child.stored.remote === "" && child.last === undefined) {
        engine.open(child.stored, "pending", false);
        engine.note(pending.id, delivered.state === "sent" ? `Sent to "${pending.sandbox}"; waiting for it to say it took the task.` : queuedWords(pending.sandbox, delivered));
    }
    engine.logger.info({ child: pending.id, parent: pending.parent, contact: row.id, delivered: delivered.state }, "contact task: handed over");
    const approve = row.theirGrants?.task?.approve === true;
    const where =
        delivered.state === "waiting"
            ? `Queued for "${pending.sandbox}": ${queuedWords(pending.sandbox, delivered)} It runs there then`
            : `Handed to "${pending.sandbox}", a contact, which ${approve ? "holds it for its owner to allow, then runs it" : "runs it"} in a conversation of its own${row.scope.kind === "person" ? ` for ${row.scope.person}, who reads it there` : ""}`;
    return { ok: true, id: pending.id, note: `${where}. ${landing} Supervise it with wait(target: "${pending.id}").` };
};

// A refused send said as the agent's answer, a queued one as a note.
const answered = (row: ContactRow, delivered: Delivery, what: string, sent: string): ChildActionResult => {
    if (delivered.state === "refused") {
        return { ok: false, message: refusedWords(row, what, delivered.reason) };
    }
    return { ok: true, note: delivered.state === "sent" ? sent : `Queued: ${queuedWords(nameOf(row), delivered)}` };
};

const reached = async (engine: ContactEngine, child: Live): Promise<ContactRow | ChildActionResult> => {
    const row = child.stored.contact === undefined ? undefined : await engine.sends.get(child.stored.contact);
    return row?.state === "accepted" ? row : { ok: false, message: `"${child.stored.sandbox}" is no longer an accepted contact here, so the task cannot be reached.` };
};

/** Follow-up words for a contact's task: a `task.message`; a settled task reopens and takes its updates again. */
export const sendToContact = async (engine: ContactEngine, child: Live, message: string): Promise<ChildActionResult> => {
    const row = await reached(engine, child);
    if ("ok" in row) {
        return row;
    }
    const delivered = await engine.sends.send(row, { kind: "task.message", task: child.stored.id, message: { message, ...opt("tainted", engine.taint(child.stored.parent)) } }, { waitMs: FIRST_ATTEMPT_MS });
    if (delivered.state !== "refused" && child.stored.settledAt !== undefined) {
        const { settledAt: _settled, report: _report, ...unsettled } = child.stored;
        child.stored = unsettled;
        child.report = undefined;
        await engine.put(child.stored);
        engine.open(child.stored, "running", true);
    }
    return answered(row, delivered, "the message", "Sent: it is said into its running turn over there, or opens the next one. Supervise it with wait.");
};

/** Picks for the question a contact's task is parked on: a `task.answer`. */
export const answerContact = async (engine: ContactEngine, child: Live, answers: Record<string, string[]>): Promise<ChildActionResult> => {
    const question = child.last?.question;
    if (question === undefined) {
        const parked = child.last?.state === "blocked";
        return { ok: false, message: parked ? `It waits on a card only the people of "${child.stored.sandbox}" may answer, not on a question for you.` : "It is not waiting on a question." };
    }
    const row = await reached(engine, child);
    if ("ok" in row) {
        return row;
    }
    const delivered = await engine.sends.send(row, { kind: "task.answer", task: child.stored.id, answer: { requestId: question.requestId, answers } }, { waitMs: FIRST_ATTEMPT_MS });
    return answered(row, delivered, "the answer", "Answered: it carries on over there with your picks.");
};

/** Stops a contact's task: a `task.stop`, its ending pushed back as any other. */
export const cancelContact = async (engine: ContactEngine, child: Live): Promise<ChildActionResult> => {
    const row = await reached(engine, child);
    if ("ok" in row) {
        return row;
    }
    const delivered = await engine.sends.send(row, { kind: "task.stop", task: child.stored.id }, { waitMs: FIRST_ATTEMPT_MS });
    return answered(row, delivered, "the stop", `Stop sent: it ends over there and its record here settles when "${child.stored.sandbox}" says so. What it already changed stays there.`);
};

/**
 * A status a contact pushed: the record moves as a follower's read would move it. A version it already took moves nothing,
 * and a settled task takes none until a follow-up reopens it. The first update names the conversation over there.
 */
export const heardUpdate = async (engine: ContactEngine, contactId: string, requestId: string, status: LinkTaskStatus): Promise<void> => {
    const child = contactChild(engine, requestId, contactId);
    if (child === undefined || child.stored.settledAt !== undefined || child.stored.version === status.version) {
        return;
    }
    const first = child.stored.remote === "";
    child.stored = { ...askedOf(child.stored, status.conversationId), version: status.version };
    await engine.put(child.stored);
    if (first) {
        engine.open(child.stored, status.state === "held" ? "pending" : "running", true);
    }
    await engine.take(child, status);
};

// The task a `task.*` payload is about, by the asking side's request id.
const requestOf = (payload: S2sPayload): string | undefined => {
    switch (payload.kind) {
        case "task.request":
            return payload.requestId;
        case "task.message":
        case "task.answer":
        case "task.stop":
        case "task.update":
            return payload.task;
        default:
            return undefined;
    }
};

/** A message to a contact let go undelivered after its first attempt: a request ends its task, anything else is said on its row. */
export const heardRefusal = async (engine: ContactEngine, contactId: string, payload: S2sPayload, reason: string): Promise<void> => {
    const requestId = requestOf(payload);
    const child = requestId === undefined ? undefined : contactChild(engine, requestId, contactId);
    if (child === undefined || child.stored.settledAt !== undefined) {
        return;
    }
    if (payload.kind === "task.request") {
        await engine.settle(child, "failed", "", `"${child.stored.sandbox}" did not take the task: ${reason}`);
        return;
    }
    engine.note(child.stored.id, `"${child.stored.sandbox}" did not take your ${payload.kind.slice("task.".length)}: ${reason}.`);
};

/** At boot: a contact's task back on the roster; one filed but never sent (the daemon stopped between) is sent now. */
export const resumeContact = async (engine: ContactEngine, entry: StoredChild): Promise<void> => {
    const child: Live = { stored: { ...entry, remote: entry.remote ?? "" }, last: undefined, report: entry.report, following: undefined };
    engine.live.set(entry.id, child);
    if (entry.settledAt !== undefined) {
        return;
    }
    engine.open(child.stored, entry.remote === undefined ? "pending" : "running", true);
    const { asking, contact } = entry;
    if (entry.remote !== undefined || asking === undefined || contact === undefined || (await engine.sends.requestQueued(contact, entry.id))) {
        return;
    }
    const row = await engine.sends.get(contact);
    if (row?.state !== "accepted") {
        await engine.settle(child, "failed", "", `"${entry.sandbox}" is no longer an accepted contact here, so the task was never handed over.`);
        return;
    }
    // Under the same request id: a far side that took it before the stop answers with the task it already has.
    const delivered = await engine.sends.send(row, { kind: "task.request", ...asking }, { hops: asking.hops, waitMs: 0 });
    if (delivered.state === "refused") {
        await engine.settle(child, "failed", "", refusedWords(row, "the task", delivered.reason));
    }
};

/**
 * A link card being upgraded into a contact (links/upgrade/): every unsettled task handed over through it, by the card's
 * id or address. `upgrade` asks the far side and answers the contact's id, or undefined when it did not become one.
 */
export type MoveToContact = (card: { readonly id: string; readonly url?: string | undefined }, upgrade: () => Promise<string | undefined>) => Promise<number>;

/**
 * Those tasks' followers stopped before the far side is asked (it moves them off the link, so a long poll there would end
 * as "no such task"), then each goes on as the contact's, since the far side now pushes its status; one never taken over
 * there is asked again under the same request id. Not upgraded, each is followed again. Answers how many moved.
 */
export const moveCardToContact = async (
    engine: ContactEngine | undefined,
    children: () => Promise<{ readonly children: readonly StoredChild[] }>,
    card: Parameters<MoveToContact>[0],
    upgrade: Parameters<MoveToContact>[1],
    followAgain: (child: Live) => void,
): Promise<number> => {
    const through = (entry: StoredChild): boolean =>
        entry.via === undefined && entry.settledAt === undefined && (entry.link === card.id || (card.url !== undefined && entry.url === card.url));
    const moving = (await children()).children.filter(through);
    const paused = moving.flatMap((entry) => {
        const live = engine?.live.get(entry.id);
        live?.following?.abort();
        return live === undefined ? [] : [live];
    });
    const failed = (error: Error): undefined => void engine?.logger.warn({ err: error, card: card.id }, "link upgrade: it failed, so the card's tasks are followed again");
    const contactId = engine === undefined ? undefined : await upgrade().catch(failed);
    if (engine === undefined || contactId === undefined) {
        paused.forEach(followAgain);
        return 0;
    }
    for (const entry of moving) {
        const { url: _url, ...rest } = entry;
        const stored: StoredChild = { ...rest, via: "contact", contact: contactId, link: `contact:${contactId}` };
        await engine.put(stored);
        await withContact(engine, (reach) => resumeContact(reach, stored));
    }
    return moving.length;
};
