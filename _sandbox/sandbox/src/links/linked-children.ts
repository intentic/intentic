import { randomUUID } from "node:crypto";
import { sleep } from "@intentic/base/async";
import type { Capability, LinkConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { childReportPrompt } from "@intentic/sandbox-contract/events/agent-words";
import { LINK_MAX_HOPS, type LinkHello, type LinkTask, type LinkTaskStatus } from "@intentic/sandbox-contract/schemas/links";
import { newConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { Logger } from "pino";
import { parentOfActor } from "../auth/principal.js";
import type { ChildActionResult, ChildParent, ChildSpawnResult, PendingChildCard } from "../agent/subagents/children.js";
import { noteQueuedReport } from "../agent/subagents/waiting/queued-reports.js";
import {
    blockedMoveReporter,
    type LinkedChildBirth,
    noteSpawnedChild,
    openLinkedChild,
    settleSpawnedChild,
    subagentEndingReported,
    subagentEndingReporter,
} from "../agent/subagents/subagents.js";
import { deliverWake, type WakeDoors } from "../seams/wake-delivery.js";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";
import { conversationTaintSource, markConversationTaint, taintWords } from "../guard/turn-taint.js";
import { opt } from "../opt.js";
import { type LinkAnswerOf, linkAnswer, linkAsk, linkHello, linkMessage, linkStatus, linkStop, type LinkTarget } from "../sandboxes/link-client.js";
import { askedOf, type AskedChild, childrenFile, type ChildrenFile, type StoredChild } from "./linked-children-store.js";
import { LINK_CONVERSATION_PREFIX } from "./link-tasks.js";

// THE ASKING SIDE OF A LINK: a task this sandbox's agent handed to another of the owner's sandboxes (`delegate`), kept on
// the parent's roster as a `linked` subagent so `wait`, `send`, `answer` and `cancel` reach it the way they reach a child
// spawned here. What differs is where it lives: its conversation, its worktree, its credentials and its landing are the
// other sandbox's, under the terms its owner set on the link, and nothing of it ever comes back into this checkout.
//
// A follower long-polls the far side for each task until it settles, moving the roster record as the task moves, and its
// ending reaches the parent as a spawned child's does: a parked wait takes it, or it wakes the parent. The far side's
// words are another sandbox's agent's, so they reach the parent as outside content.

// Every roster id a link task gets, which also tells a supervisor's call which engine it is for.
export const LINKED_PREFIX = "linked-";
// How long a follower waits before asking again when the far side did not answer, growing to the ceiling.
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;
// Characters of a report a wake says inline; the rest stays over there, and a wait hands it whole.
const REPORT_CHARS = 4_000;
// How long `links` waits on each linked sandbox's answer before calling it offline.
const HELLO_MS = 8_000;
// How far up a family `hopsOf` walks; nesting stops far below this, it only bounds a corrupt registry's loop.
const FAMILY_WALK = 32;

export interface DelegateAsk {
    // The link card's id: the agent's name for the other sandbox.
    readonly to: string;
    readonly task: string;
    readonly description?: string | undefined;
}

// One link card as `links` lists it for the agent: where it goes, and whether that sandbox answers right now.
export interface LinkListing {
    readonly to: string;
    readonly sandbox: string;
    readonly online: boolean;
    readonly why?: string;
    readonly persona?: string;
    readonly approve?: boolean;
    readonly turnsPerHour?: number;
}

export interface LinkWire {
    readonly hello: typeof linkHello;
    readonly ask: typeof linkAsk;
    readonly status: typeof linkStatus;
    readonly message: typeof linkMessage;
    readonly answer: typeof linkAnswer;
    readonly stop: typeof linkStop;
}

const WIRE: LinkWire = { hello: linkHello, ask: linkAsk, status: linkStatus, message: linkMessage, answer: linkAnswer, stop: linkStop };

export interface LinkedChildrenDeps {
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly conversations: Pick<ConversationActors, "holdings" | "send">;
    readonly standingOf: (conversationId: string) => TurnStanding | undefined;
    // A conversation's registry facts: who started it, its title.
    readonly entryOf: (conversationId: string) => { readonly startedBy?: string | undefined; readonly title?: string | undefined } | undefined;
    // What a conversation runs as now, which a wake into it continues.
    readonly profileOf: (conversationId: string) => TurnProfile | undefined;
    // How many links the task a conversation here was opened by had crossed; undefined for one no link opened.
    readonly inboundHops: (conversationId: string) => Promise<number | undefined>;
    readonly doors: WakeDoors;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly historyPath: string;
    // The wire, injectable so a test can stand the far sandbox in.
    readonly wire?: LinkWire;
}

export interface LinkedChildren {
    readonly owns: (childId: string) => boolean;
    readonly delegate: (parent: ChildParent, ask: DelegateAsk) => Promise<ChildSpawnResult>;
    readonly links: (conversationId: string) => Promise<readonly LinkListing[]>;
    // One card's listing, for its own `about` tool; undefined for a card this turn was not granted.
    readonly about: (conversationId: string, link: string) => Promise<LinkListing | undefined>;
    readonly send: (parent: ChildParent, childId: string, message: string) => Promise<ChildActionResult>;
    readonly answer: (parent: ChildParent, childId: string, answers: Record<string, string[]>) => Promise<ChildActionResult>;
    readonly cancel: (parent: ChildParent, childId: string) => Promise<ChildActionResult>;
    readonly report: (childId: string) => string | undefined;
    readonly pendingQuestion: (childId: string) => PendingChildCard | undefined;
    readonly landing: (childId: string) => string | undefined;
    // Picks the following back up for every task still out at boot.
    readonly resume: () => Promise<void>;
    readonly close: () => void;
}

// What the follower knows of one task between polls, in memory beside its stored record.
interface Live {
    stored: AskedChild;
    last: LinkTaskStatus | undefined;
    report: string | undefined;
    following: AbortController | undefined;
}

type LinkCard = Extract<Capability, { kind: "link" }>;

// Everything the engine's parts share: its deps, the wire, every task it knows, its file, and whether it has closed.
interface Engine extends ChildrenFile {
    readonly deps: LinkedChildrenDeps;
    readonly wire: LinkWire;
    readonly live: Map<string, Live>;
    readonly state: { closed: boolean };
}

const isLinkCard = (capability: Capability): capability is LinkCard => capability.kind === "link";

const targetOf = (card: LinkCard): LinkTarget => ({ id: card.id, config: card.config });

const sandboxNameOf = (card: { readonly id: string; readonly config: LinkConfig }): string => card.config.name ?? card.id;

/** Where a linked task's work goes, in its parent's words. */
export const linkedLandingWords = (sandbox: string): string =>
    `Its work stays in the sandbox "${sandbox}": it ran in that sandbox's own copy of its repos and lands there, under that sandbox's own rules, never into your checkout.`;

const reportCut = (report: string, childId: string): string =>
    report.length <= REPORT_CHARS ? report : `${report.slice(0, REPORT_CHARS)}… (cut here: wait(target: "${childId}") returns its whole report)`;

// The source a linked task's words are marked with, wherever they reach this sandbox.
const outsideFrom = (sandbox: string): string => `the report of a task the linked sandbox "${sandbox}" ran`;

// What the asking turn had itself taken in, in words, for the far side to carry on.
const taintOf = (conversationId: string): string | undefined => {
    const source = conversationTaintSource(conversationId);
    return source === undefined ? undefined : taintWords(source).slice(0, 500);
};

const birthOf = (stored: AskedChild, status: LinkedChildBirth["status"], again: boolean): LinkedChildBirth => ({
    id: stored.id,
    ...opt("description", stored.description),
    linked: { link: stored.link, sandbox: stored.sandbox, ...opt("sandboxId", stored.sandboxId), conversationId: stored.remote },
    status,
    ...opt("again", again ? (true as const) : undefined),
});

const openRecord = (engine: Engine, stored: AskedChild, status: LinkedChildBirth["status"], again: boolean): void =>
    openLinkedChild({ conversationId: stored.parent, conversations: engine.deps.conversations, subagentsDir: undefined }, birthOf(stored, status, again));

// The card a task went through: by its name, else by its address, which a rename leaves alone.
const cardFor = async (engine: Engine, link: string, url?: string): Promise<LinkCard | undefined> => {
    const cards = (await engine.deps.capabilities()).filter(isLinkCard);
    return cards.find((card) => card.id === link) ?? (url === undefined ? undefined : cards.find((card) => card.config.url === url));
};

// Words into the parent's turn, as the sandbox's and marked as the far side's; where they went, or nowhere.
const sayToParent = async (engine: Engine, stored: StoredChild, prompt: string, messageId: string): Promise<"said" | "queued" | "none"> => {
    const profile = engine.deps.profileOf(stored.parent);
    if (profile === undefined || engine.deps.entryOf(stored.parent) === undefined) {
        return "none";
    }
    const receipt = await deliverWake(engine.deps.doors, {
        conversationId: stored.parent,
        prompt,
        voice: "sandbox",
        outside: outsideFrom(stored.sandbox),
        profile,
        messageId,
        source: "links",
    });
    if ("why" in receipt || "invalid" in receipt) {
        engine.deps.logger.info({ parent: stored.parent, child: stored.id }, "linked task: its parent took nothing");
        return "none";
    }
    return receipt.delivered === "queued" ? "queued" : "said";
};

// The task settled over there: the record ends, and its report reaches the parent unless a wait already took it.
const settle = async (engine: Engine, child: Live, status: "completed" | "failed" | "killed", report: string, error?: string): Promise<void> => {
    const { stored } = child;
    const { conversations, logger } = engine.deps;
    child.report = report;
    // The far side's words reach the parent's live turn whichever door hands them over.
    markConversationTaint(stored.parent, outsideFrom(stored.sandbox));
    settleSpawnedChild(conversations, stored.id, { status, report, ...opt("error", error) });
    if (stored.settledAt === undefined) {
        stored.settledAt = Date.now();
        stored.report = report === "" ? undefined : report;
        await engine.put(stored).catch((failure: Error) => logger.warn({ err: failure, child: stored.id }, "linked task: its ending was not filed"));
    }
    const reported = subagentEndingReporter(conversations, stored.id);
    if (subagentEndingReported(conversations, stored.id)) {
        return;
    }
    const messageId = `linked-report-${randomUUID()}`;
    const ended = error === undefined ? [] : [`It ended: ${error}`];
    const prompt = childReportPrompt({
        child: stored.id,
        title: stored.description,
        failed: status !== "completed",
        report: [reportCut(report, stored.id), ...ended].filter((part) => part !== "").join("\n\n"),
        verification: undefined,
        landing: linkedLandingWords(stored.sandbox),
    });
    const said = await sayToParent(engine, stored, prompt, messageId);
    if (said === "queued") {
        noteQueuedReport(conversations, stored.id, { parent: stored.parent, messageId });
    } else if (said === "said") {
        reported();
    }
};

const questionWords = (stored: StoredChild, question: NonNullable<LinkTaskStatus["question"]>): string =>
    [
        `Subagent \`${stored.id}\`, the task you handed to the linked sandbox "${stored.sandbox}", asks:`,
        "",
        ...question.questions.map((entry) => {
            const options = entry.options.map((option) => option.label).join(" / ");
            return options === "" ? `- ${entry.question}` : `- ${entry.question} (${options})`;
        }),
        "",
        `Answer it with answer(child: "${stored.id}"), or send it words with send.`,
    ].join("\n");

// A task parked over there: blocked on the roster, and a question the parent may answer said into its turn once.
const takeBlocked = async (engine: Engine, child: Live, status: LinkTaskStatus, before: LinkTaskStatus | undefined): Promise<void> => {
    const { stored } = child;
    const question = status.question;
    const waitingOn = status.waitingOn ?? "its owner over there";
    noteSpawnedChild(engine.deps.conversations, stored.id, { status: "blocked", summary: question?.questions[0]?.question ?? `Waiting on ${waitingOn}.` });
    if (question === undefined || before?.question?.requestId === question.requestId) {
        return;
    }
    const asked = blockedMoveReporter(engine.deps.conversations, stored.id);
    if (asked !== undefined && (await sayToParent(engine, stored, questionWords(stored, question), `linked-question-${randomUUID()}`)) !== "none") {
        asked();
    }
};

// One status read onto the roster record; true once the task has settled and the follower may stop.
const take = async (engine: Engine, child: Live, status: LinkTaskStatus): Promise<boolean> => {
    const before = child.last;
    child.last = status;
    const { conversations } = engine.deps;
    const report = status.report ?? "";
    switch (status.state) {
        case "held":
            noteSpawnedChild(conversations, child.stored.id, { status: "pending", summary: `Waiting for the owner of "${child.stored.sandbox}" to allow it there.` });
            return false;
        case "running":
            // A fresh run clears what the last parking said; a running one keeps its row as it is.
            noteSpawnedChild(conversations, child.stored.id, before?.state === "running" ? { status: "running" } : { status: "running", summary: "" });
            return false;
        case "blocked":
            await takeBlocked(engine, child, status, before);
            return false;
        case "finished":
            await settle(engine, child, "completed", report);
            return true;
        case "failed":
            await settle(engine, child, "failed", report, status.error ?? "its turn failed over there");
            return true;
        case "declined":
            await settle(engine, child, "failed", "", `The owner of "${child.stored.sandbox}" declined it, so nothing of it ran there.`);
            return true;
        case "stopped":
            await settle(engine, child, "killed", report, "It was stopped before it finished.");
            return true;
    }
};

// One look at the far side for the follower: settled (stop following), moved (look again now), or unanswered (wait first).
const lookOnce = async (engine: Engine, child: Live, signal: AbortSignal): Promise<"settled" | "moved" | "unanswered"> => {
    const card = await cardFor(engine, child.stored.link, child.stored.url);
    if (card === undefined) {
        await settle(engine, child, "failed", "", `The link card "${child.stored.link}" was removed here, so nothing more can be read of it.`);
        return "settled";
    }
    const answer = await engine.wire.status(targetOf(card), child.stored.remote, { ...opt("after", child.last?.version) }, signal);
    if (answer.ok) {
        return (await take(engine, child, answer.value)) ? "settled" : "moved";
    }
    if (signal.aborted) {
        return "settled";
    }
    if (answer.status === 401 || answer.status === 404) {
        await settle(engine, child, "failed", "", `"${child.stored.sandbox}" no longer answers for it: ${answer.message}.`);
        return "settled";
    }
    noteSpawnedChild(engine.deps.conversations, child.stored.id, { summary: `"${child.stored.sandbox}" did not answer: ${answer.message}. Asking again.` });
    return "unanswered";
};

// Follows one task until it settles, the link goes, or the daemon closes. A far side that does not answer is asked
// again, ever less often; one that no longer knows the task or the link ends it as failed, since nothing will move it.
const follow = (engine: Engine, child: Live): void => {
    child.following?.abort();
    const following = new AbortController();
    child.following = following;
    const loop = async (): Promise<void> => {
        let retryMs = RETRY_FIRST_MS;
        for (;;) {
            if (engine.state.closed || following.signal.aborted) {
                return;
            }
            const looked = await lookOnce(engine, child, following.signal);
            if (looked === "settled") {
                return;
            }
            if (looked === "moved") {
                retryMs = RETRY_FIRST_MS;
                continue;
            }
            await sleep(retryMs, { signal: following.signal, unref: true });
            retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        }
    };
    void loop().catch((error: Error) => engine.deps.logger.warn({ err: error, child: child.stored.id }, "linked task: the follower stopped"));
};

// How many links the parent's own work already crossed: the root of its family, opened by a link here or not.
const hopsOf = async (deps: LinkedChildrenDeps, conversationId: string): Promise<number> => {
    let at = conversationId;
    for (let step = 0; step < FAMILY_WALK; step += 1) {
        const parent = parentOfActor(deps.entryOf(at)?.startedBy);
        if (parent === undefined) {
            break;
        }
        at = parent;
    }
    return at.startsWith(LINK_CONVERSATION_PREFIX) ? ((await deps.inboundHops(at)) ?? 0) + 1 : 0;
};

// Why this turn may not hand work to that card, or undefined when it may.
const delegateRefusal = async (engine: Engine, parent: ChildParent, ask: DelegateAsk, card: LinkCard | undefined): Promise<string | undefined> => {
    if (card === undefined) {
        const names = (await engine.deps.capabilities()).filter(isLinkCard).map((entry) => entry.id);
        return names.length === 0
            ? 'This sandbox is linked to no other sandbox. Connecting one is the owner\'s: `capabilities request link --why "…"`.'
            : `No linked sandbox is called "${ask.to}". Linked here: ${names.join(", ")}.`;
    }
    const standing = engine.deps.standingOf(parent.conversationId);
    if (standing !== undefined && !standing.granted.includes(card.id)) {
        return `This conversation's turn was not given the "${card.id}" link: its persona or the people it works for leave it out. Do the work here, or say what you left undone.`;
    }
    return undefined;
};

const delegate = async (engine: Engine, parent: ChildParent, ask: DelegateAsk): Promise<ChildSpawnResult> => {
    const card = await cardFor(engine, ask.to);
    const refusal = await delegateRefusal(engine, parent, ask, card);
    if (refusal !== undefined || card === undefined) {
        return { ok: false, message: refusal ?? `No linked sandbox is called "${ask.to}".` };
    }
    const hops = await hopsOf(engine.deps, parent.conversationId);
    if (hops >= LINK_MAX_HOPS) {
        return {
            ok: false,
            message: `This work already came here over ${hops} ${hops === 1 ? "link" : "links"}, and a task is never handed on past ${LINK_MAX_HOPS}: do it here, or report back what you could not.`,
        };
    }
    const id = `${LINKED_PREFIX}${newConversationId()}`;
    const asking: LinkTask = {
        requestId: id,
        task: ask.task,
        ...opt("title", ask.description?.slice(0, 80)),
        hops,
        ...opt("tainted", taintOf(parent.conversationId)),
        from: { conversation: parent.conversationId, ...opt("title", engine.deps.entryOf(parent.conversationId)?.title?.slice(0, 200)) },
    };
    const pending: StoredChild = {
        id,
        parent: parent.conversationId,
        link: card.id,
        url: card.config.url,
        sandbox: sandboxNameOf(card),
        ...opt("sandboxId", card.config.sandboxId),
        asking,
        ...opt("description", ask.description ?? ask.task.split("\n")[0]?.slice(0, 120)),
        startedAt: Date.now(),
    };
    // Filed before it is asked: a daemon that stops between the two asks again at boot (reask), rather than leaving a
    // task over there that nobody here follows.
    await engine.put(pending);
    const asked = await engine.wire.ask(targetOf(card), asking);
    if (!asked.ok) {
        await engine.drop(id);
        return { ok: false, message: `"${sandboxNameOf(card)}" did not take the task: ${asked.message}.` };
    }
    const child = await adopt(engine, pending, asked.value);
    const { stored } = child;
    const held = asked.value.state === "held";
    await startFollowing(engine, child, asked.value, held ? "pending" : "running");
    engine.deps.logger.info({ child: id, parent: parent.conversationId, link: card.id, remote: stored.remote }, "linked task: handed over");
    const where = held
        ? `Handed to "${stored.sandbox}", where it waits for that sandbox's owner to allow it.`
        : `Handed to "${stored.sandbox}", which is working on it in its own conversation. ${linkedLandingWords(stored.sandbox)}`;
    return { ok: true, id, note: `${where} Supervise it with wait(target: "${id}").` };
};

const listLinks = async (engine: Engine, conversationId: string, only?: string): Promise<readonly LinkListing[]> => {
    const standing = engine.deps.standingOf(conversationId);
    const cards = (await engine.deps.capabilities())
        .filter(isLinkCard)
        .filter((card) => (standing === undefined || standing.granted.includes(card.id)) && (only === undefined || card.id === only));
    return Promise.all(
        cards.map(async (card): Promise<LinkListing> => {
            const hello: LinkAnswerOf<LinkHello> = await engine.wire.hello(targetOf(card), AbortSignal.timeout(HELLO_MS));
            if (!hello.ok) {
                return { to: card.id, sandbox: sandboxNameOf(card), online: false, why: hello.message };
            }
            const { terms } = hello.value;
            return {
                to: card.id,
                // The name the owner knows it by, from pairing; what it calls itself is only its container's name.
                sandbox: card.config.name ?? hello.value.sandbox,
                online: true,
                ...opt("persona", terms.persona),
                approve: terms.approve,
                turnsPerHour: terms.turnsPerHour,
            };
        }),
    );
};

const SENT_NOTES = {
    steered: "Steered: it lands between its tool calls over there.",
    queued: "Queued over there behind what that conversation is doing; supervise it with wait.",
    started: "Sent: it runs a follow-up turn over there. Supervise it with wait.",
} as const;

const sendTo = async (engine: Engine, child: Live, message: string): Promise<ChildActionResult> => {
    const card = await cardFor(engine, child.stored.link, child.stored.url);
    if (card === undefined) {
        return { ok: false, message: `The link card "${child.stored.link}" was removed here, so the task cannot be reached any more.` };
    }
    const sent = await engine.wire.message(targetOf(card), child.stored.remote, { message, ...opt("tainted", taintOf(child.stored.parent)) });
    if (!sent.ok) {
        return { ok: false, message: `"${child.stored.sandbox}" did not take it: ${sent.message}.` };
    }
    // A settled task reopens: its record is live again and the follower picks it back up.
    if (child.stored.settledAt !== undefined || child.following === undefined) {
        const { settledAt: _settled, report: _report, ...unsettled } = child.stored;
        child.stored = unsettled;
        child.report = undefined;
        await engine.put(child.stored);
        openRecord(engine, child.stored, "running", true);
        follow(engine, child);
    }
    return { ok: true, note: SENT_NOTES[sent.value.delivered] };
};

const answerTo = async (engine: Engine, child: Live, answers: Record<string, string[]>): Promise<ChildActionResult> => {
    const question = child.last?.question;
    if (question === undefined) {
        const parked = child.last?.state === "blocked";
        return {
            ok: false,
            message: parked ? `It waits on a card only the owner of "${child.stored.sandbox}" may answer, not on a question for you.` : "It is not waiting on a question.",
        };
    }
    const card = await cardFor(engine, child.stored.link, child.stored.url);
    if (card === undefined) {
        return { ok: false, message: `The link card "${child.stored.link}" was removed here.` };
    }
    const answered = await engine.wire.answer(targetOf(card), child.stored.remote, { requestId: question.requestId, answers });
    return answered.ok ? { ok: true, note: "Answered: it carries on over there with your picks." } : { ok: false, message: answered.message };
};

const cancelOf = async (engine: Engine, child: Live): Promise<ChildActionResult> => {
    const card = await cardFor(engine, child.stored.link, child.stored.url);
    if (card === undefined) {
        return { ok: false, message: `The link card "${child.stored.link}" was removed here.` };
    }
    const stopped = await engine.wire.stop(targetOf(card), child.stored.remote);
    if (!stopped.ok) {
        return { ok: false, message: `"${child.stored.sandbox}" did not stop it: ${stopped.message}.` };
    }
    child.following?.abort();
    child.following = undefined;
    await take(engine, child, stopped.value);
    return { ok: true, note: `Stopped over there. What it already changed stays in "${child.stored.sandbox}"; send it a message to carry on.` };
};

// The far side took the task: its conversation there is on file and the ask is not kept any more.
const adopt = async (engine: Engine, pending: StoredChild, status: LinkTaskStatus): Promise<Live> => {
    const stored = askedOf(pending, status.conversationId);
    await engine.put(stored);
    const child: Live = { stored, last: undefined, report: undefined, following: undefined };
    engine.live.set(stored.id, child);
    return child;
};

// On the parent's roster, then the first status taken and, unless that settled it, followed.
const startFollowing = async (engine: Engine, child: Live, status: LinkTaskStatus, as: LinkedChildBirth["status"]): Promise<void> => {
    openRecord(engine, child.stored, as, false);
    if (!(await take(engine, child, status))) {
        follow(engine, child);
    }
};

// A task filed here whose ask the far side never answered before the daemon stopped: asked again under the same id until
// the far side answers. One it refuses (or a card since removed) was never taken over there, so its record goes.
const reask = async (engine: Engine, pending: StoredChild & { asking: LinkTask }): Promise<void> => {
    let retryMs = RETRY_FIRST_MS;
    while (!engine.state.closed) {
        const card = await cardFor(engine, pending.link, pending.url);
        const asked = card === undefined ? undefined : await engine.wire.ask(targetOf(card), pending.asking);
        if (asked?.ok === true) {
            await startFollowing(engine, await adopt(engine, pending, asked.value), asked.value, asked.value.state === "held" ? "pending" : "running");
            engine.deps.logger.info({ child: pending.id, remote: asked.value.conversationId }, "linked task: handed over after a restart");
            return;
        }
        if (asked === undefined || (asked.status >= 400 && asked.status < 500)) {
            await engine.drop(pending.id);
            engine.deps.logger.warn({ child: pending.id, why: asked?.message ?? "its link card was removed" }, "linked task: not taken over there after a restart");
            return;
        }
        await sleep(retryMs, { unref: true });
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
};

const resume = async (engine: Engine): Promise<void> => {
    const stored = (await engine.read()).children;
    for (const entry of stored) {
        const { remote, asking } = entry;
        if (remote === undefined) {
            void (asking === undefined ? engine.drop(entry.id) : reask(engine, { ...entry, asking })).catch((error: Error) =>
                engine.deps.logger.warn({ err: error, child: entry.id }, "linked task: not asked again"),
            );
            continue;
        }
        const child: Live = { stored: { ...entry, remote }, last: undefined, report: entry.report, following: undefined };
        engine.live.set(entry.id, child);
        if (entry.settledAt === undefined) {
            openRecord(engine, child.stored, "running", true);
            follow(engine, child);
        }
    }
    const following = stored.filter((entry) => entry.settledAt === undefined).length;
    if (following > 0) {
        engine.deps.logger.info({ following }, "linked tasks: following again after a restart");
    }
};

export const createLinkedChildren = (deps: LinkedChildrenDeps): LinkedChildren => {
    const engine: Engine = { deps, wire: deps.wire ?? WIRE, live: new Map(), ...childrenFile(deps.historyPath), state: { closed: false } };
    // The parent's own task, or nothing: a task is reached only from the conversation that handed it over.
    const mine = (parent: ChildParent, childId: string): Live | undefined => {
        const child = engine.live.get(childId);
        return child?.stored.parent === parent.conversationId ? child : undefined;
    };
    const notMine: ChildActionResult = { ok: false, message: "No such task of this conversation. `list` shows yours." };
    return {
        owns: (childId) => childId.startsWith(LINKED_PREFIX) && engine.live.has(childId),
        delegate: (parent, ask) => delegate(engine, parent, ask),
        links: (conversationId) => listLinks(engine, conversationId),
        about: async (conversationId, link) => (await listLinks(engine, conversationId, link))[0],
        send: async (parent, childId, message) => {
            const child = mine(parent, childId);
            return child === undefined ? notMine : sendTo(engine, child, message);
        },
        answer: async (parent, childId, answers) => {
            const child = mine(parent, childId);
            return child === undefined ? notMine : answerTo(engine, child, answers);
        },
        cancel: async (parent, childId) => {
            const child = mine(parent, childId);
            return child === undefined ? notMine : cancelOf(engine, child);
        },
        report: (childId) => {
            const report = engine.live.get(childId)?.report;
            return report === "" ? undefined : report;
        },
        pendingQuestion: (childId) => {
            const question = engine.live.get(childId)?.last?.question;
            return question === undefined ? undefined : { kind: "question", requestId: question.requestId, questions: question.questions };
        },
        landing: (childId) => {
            const child = engine.live.get(childId);
            return child === undefined ? undefined : linkedLandingWords(child.stored.sandbox);
        },
        resume: () => resume(engine),
        close: () => {
            engine.state.closed = true;
            for (const child of engine.live.values()) {
                child.following?.abort();
            }
        },
    };
};
