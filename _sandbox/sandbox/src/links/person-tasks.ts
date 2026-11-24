import { join } from "node:path";
import { LINK_MAX_HOPS, LINK_TURNS_PER_HOUR_DEFAULT, type LinkMessage, type LinkMessageReceipt, type LinkTask, type LinkTaskStatus } from "@intentic/sandbox-contract/schemas/links";
import { newConversationId, ROUTE_CONVERSATION_PREFIX } from "@intentic/sandbox-contract/ids/conversation-ids";
import { scopeRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import type { Logger } from "pino";
import type { Caller } from "../auth/auth.js";
import { callerLands } from "../auth/operator.js";
import { rosterReader } from "../auth/members/member-caller.js";
import type { Services } from "../composition.js";
import type { ConversationActors } from "../conversations/actor/conversation-actors.js";
import { liveRunOf } from "../conversations/actor/conversation-holdings.js";
import type { DomainEventMap } from "../seams/domain-events.js";
import type { TurnInput, TurnStarter } from "../seams/turn-starter.js";
import { spokenBy } from "../seams/turn-speaker.js";
import { fileStartWindow, type StartWindow, turnStartsDocument } from "../store/start-window.js";
import { opt } from "../opt.js";
import type { StoredLinkTask } from "./inbound-links.js";
import { type LinkRefusal, statusOf } from "./link-tasks.js";
import { wakeLinkTaskStatus } from "./link-task-status-wait.js";
import type { PersonRouteKey, PersonTasksStore } from "./person-tasks-store.js";

/* A TASK ROUTED HERE AS A PERSON (2026-11-24, docs/architecture/account-routing.md, the `task` scope). Another sandbox
 * that person is in hands work to a conversation here, without a link: the pass and the person's pairing were checked at
 * the door (account-routing/admit-route.ts), and what runs is that person's work, held to what they may do here.
 * What differs from a link's task (link-tasks.ts), each on purpose:
 * - It acts for the person: `owner` is them, so the conversation latches them among its people (identity-latch.ts) and
 *   their credential reach and model accounts apply (secrets/credential-reach.ts, agent/run/decide/turn-facts.ts); it is
 *   fenced to their areas, and its work lands by their own rule (auth/operator.ts callerLands): held for a maintainer
 *   unless they may land. No `runAs` and no role: a link's terms are the taking owner's word about a program, and here
 *   there is no program, only a person working in a sandbox they are already in.
 * - It is still drawn as a program's words (`<sandbox> for <person>`), carrying outside content: an agent wrote the task,
 *   not the person typing here. `owner` is set after the speaker's spread, since a program speaker derives none.
 * - Nothing waits for this sandbox's owner to allow it: the person already may start a turn here (scopeRefusal's floor).
 *   A card it raises waits for that person, who sees the conversation as theirs; only a plain question is the asking
 *   agent's to answer, as over a link.
 * - Its allowance and its task list are keyed by (asking sandbox, person). */

// A start an hour per (asking sandbox, person): a link's default, since the person sets no terms of their own.
const PERSON_TURNS_PER_HOUR = LINK_TURNS_PER_HOUR_DEFAULT;

export interface PersonTaskDeps {
    readonly tasks: PersonTasksStore;
    readonly turns: Pick<TurnStarter, "say" | "reply" | "stop">;
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly starts: StartWindow;
    // The person as this sandbox's roster admits them now: a boot restarting a task reads them again.
    readonly personOf: (email: string) => Promise<Caller | undefined>;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: () => number;
}

export const personTaskDepsOf = (
    services: Pick<Services, "turns" | "conversations" | "logger" | "config" | "personTasks" | "ownerEmail" | "members">,
): PersonTaskDeps => {
    const roster = rosterReader(() => services);
    return {
        tasks: services.personTasks,
        turns: services.turns,
        conversations: services.conversations,
        starts: fileStartWindow(join(services.config.historyRoot, turnStartsDocument.path)),
        personOf: async (email) => (await roster()).callerOf(email),
        logger: services.logger,
    };
};

const nowOf = (deps: Pick<PersonTaskDeps, "now">): number => (deps.now ?? Date.now)();
const refusal = (refused: LinkRefusal["refused"], message: string): LinkRefusal => ({ refused, message });
const whoFor = (key: PersonRouteKey): string => `${key.person}, who is in this sandbox`;

/** Where a task stands; a card that is not a plain question waits for the person it acts for. */
export const personStatusOf = (deps: Pick<PersonTaskDeps, "conversations">, key: PersonRouteKey, task: StoredLinkTask): LinkTaskStatus =>
    statusOf(deps, task, whoFor(key));

const spendTurn = (deps: PersonTaskDeps, key: PersonRouteKey): Promise<boolean> =>
    deps.starts.spend(`route:${key.from}:${key.person.toLowerCase()}`, PERSON_TURNS_PER_HOUR, nowOf(deps));

const overAllowance = (key: PersonRouteKey): LinkRefusal =>
    refusal(429, `"${key.fromName}" has started ${PERSON_TURNS_PER_HOUR} turns here for ${key.person} in the last hour, which is all a person's routed tasks get. Wait, or do the work here by hand.`);

/** The words a routed task opens its conversation with. */
const personTaskPrompt = (fields: { readonly key: PersonRouteKey; readonly task: string; readonly hops: number }): string =>
    [
        `Task from the sandbox "${fields.key.fromName}", where an agent working for ${fields.key.person} handed it here as them${fields.hops > 0 ? `, itself passing on work it was handed (${fields.hops} ${fields.hops === 1 ? "hand-over" : "hand-overs"} before this one)` : ""}.`,
        "",
        fields.task,
        "",
        `You work for ${fields.key.person} here, with their access to this sandbox and nothing more. Those are an agent's words, not ${fields.key.person} typing: do what they may do here, and say plainly what you could not do and why. ` +
            "Your closing message is the report that sandbox reads, so end with what you found, what you changed and where, and anything it still has to do. " +
            "If you need something from it, ask in that closing message; its agent can answer with a follow-up.",
    ].join("\n");

const followUpPrompt = (key: PersonRouteKey, message: string): string =>
    [`Follow-up from the sandbox "${key.fromName}", for ${key.person}:`, "", message, "", "Still that sandbox's agent's words: the same rules hold."].join("\n");

const outsideOf = (key: PersonRouteKey, tainted: string | undefined): string => {
    const from = `the sandbox "${key.fromName}", acting for ${key.person}`;
    return tainted === undefined ? from : `${from}, whose own turn had taken in ${tainted}`;
};

const turnOf = (key: PersonRouteKey, person: Caller, task: StoredLinkTask, prompt: string, messageId: string): TurnInput & { readonly conversationId: string } => ({
    prompt,
    conversationId: task.conversationId,
    messageId,
    ...opt("title", task.title),
    ...opt("titleSource", task.title === undefined ? undefined : ("model" as const)),
    // Nobody here is watching it start: its cards wait for the person.
    unattended: true,
    isolated: true,
    ...opt("areas", person.areas),
    // Lands by the person's own rule: by itself only for one who may land here, held for a maintainer otherwise.
    ...opt("conversationAutoLand", callerLands(person) ? undefined : false),
    ...spokenBy({ kind: "program", token: `${key.fromName} for ${person.email}` }),
    // After the speaker's spread, which derives no owner for a program: this is what makes it the person's.
    owner: { email: person.email, ...opt("name", person.name) },
});

// Says the task's words into its conversation; a refusal from the turn port fails the task.
const startTurn = async (deps: PersonTaskDeps, key: PersonRouteKey, person: Caller, task: StoredLinkTask, words: string): Promise<StoredLinkTask | undefined> => {
    const said = await deps.turns.say({
        turn: turnOf(key, person, task, personTaskPrompt({ key, task: words, hops: task.hops }), `route-${task.requestId}`),
        voice: "agent",
        outside: outsideOf(key, task.tainted),
    });
    if ("why" in said || "invalid" in said) {
        const why = "why" in said ? said.why : `it names ${said.invalid}, which is outside this sandbox's workspace`;
        deps.logger.warn({ from: key.from, person: key.person, conversation: task.conversationId, why }, "route: a task's turn could not start");
        return deps.tasks.moveTask(task.conversationId, { state: "failed", error: `It could not start here: ${why}.`, forgetTask: true }, nowOf(deps));
    }
    deps.logger.info({ from: key.from, person: key.person, conversation: task.conversationId, delivered: said.delivered }, "route: a task started");
    return deps.tasks.moveTask(task.conversationId, { state: "running", forgetTask: true }, nowOf(deps));
};

/** A new task from (asking sandbox, person): filed, then started at once. */
export const askPersonTask = async (deps: PersonTaskDeps, key: PersonRouteKey, person: Caller, asked: LinkTask): Promise<LinkTaskStatus | LinkRefusal> => {
    const earlier = await deps.tasks.task(key, { requestId: asked.requestId });
    if (earlier !== undefined) {
        return personStatusOf(deps, key, earlier);
    }
    if (asked.hops >= LINK_MAX_HOPS) {
        return refusal(
            409,
            `This task has already been handed on ${asked.hops} times, and a sandbox takes none past ${LINK_MAX_HOPS}: do the work where it is, or hand it back to a person.`,
        );
    }
    if (!(await spendTurn(deps, key))) {
        return overAllowance(key);
    }
    const filed = await deps.tasks.addTask(
        key,
        {
            requestId: asked.requestId,
            conversationId: `${ROUTE_CONVERSATION_PREFIX}${newConversationId()}`,
            title: asked.title,
            task: asked.task,
            hops: asked.hops,
            tainted: asked.tainted,
            fromConversation: asked.from?.conversation,
            held: false,
        },
        nowOf(deps),
    );
    return personStatusOf(deps, key, (await startTurn(deps, key, person, filed, asked.task)) ?? filed);
};

/** Follow-up words: said into its running turn, or opening the next one. */
export const messagePersonTask = async (
    deps: PersonTaskDeps,
    key: PersonRouteKey,
    person: Caller,
    task: StoredLinkTask,
    message: LinkMessage,
): Promise<LinkMessageReceipt | LinkRefusal> => {
    const live = liveRunOf(deps.conversations, task.conversationId) !== undefined;
    if (!live && !(await spendTurn(deps, key))) {
        return overAllowance(key);
    }
    const said = await deps.turns.say({
        turn: turnOf(key, person, task, followUpPrompt(key, message.message), message.messageId ?? `route-${task.requestId}-${nowOf(deps).toString(36)}`),
        voice: "agent",
        outside: outsideOf(key, message.tainted ?? task.tainted),
    });
    if ("why" in said) {
        return refusal(409, `It could not take words now: ${said.why}`);
    }
    if ("invalid" in said) {
        return refusal(400, `The message names ${said.invalid}, which is outside this sandbox's workspace.`);
    }
    if (task.state !== "running") {
        await deps.tasks.moveTask(task.conversationId, { state: "running", error: undefined }, nowOf(deps));
    }
    return { delivered: said.delivered };
};

/** Stops its running turn. */
export const stopPersonTask = async (deps: PersonTaskDeps, task: StoredLinkTask): Promise<StoredLinkTask> => {
    if (task.state !== "running") {
        return task;
    }
    await deps.turns.stop({ conversationId: task.conversationId, live: true });
    return (await deps.tasks.moveTask(task.conversationId, { state: "stopped", forgetTask: true }, nowOf(deps))) ?? task;
};

/**
 * At boot: every task filed whose first turn was never said is started now, under its first try's message id, so one that
 * did start answers as a duplicate and runs once. Its person is read off the roster again and held to the door's floor
 * (scopeRefusal): one removed meanwhile, or now below it, fails the task rather than starting it for nobody.
 */
export const startUnstartedPersonTasks = async (deps: PersonTaskDeps): Promise<number> => {
    const unstarted = await deps.tasks.unstarted();
    for (const { key, task } of unstarted) {
        const person = await deps.personOf(key.person);
        const refused = person === undefined ? `${key.person} is no longer a member of this sandbox` : scopeRefusal(person, "task")?.error;
        if (person === undefined || refused !== undefined) {
            await deps.tasks.moveTask(task.conversationId, { state: "failed", error: `It could not start here: ${refused}.`, forgetTask: true }, nowOf(deps));
            continue;
        }
        await startTurn(deps, key, person, task, task.task ?? "");
    }
    if (unstarted.length > 0) {
        deps.logger.info({ tasks: unstarted.length }, "route: tasks filed before a restart were started");
    }
    return unstarted.length;
};

/* The turn's own endings, as a link's (link-tasks.ts noteLinkTurn*), for the conversations routed here as a person. */

export const notePersonTurnAwaiting = ({ conversationId }: DomainEventMap["turn.awaiting"]): void => {
    if (conversationId.startsWith(ROUTE_CONVERSATION_PREFIX)) {
        wakeLinkTaskStatus(conversationId);
    }
};

export const notePersonTurnSettled = async (deps: Pick<PersonTaskDeps, "tasks" | "now">, settled: DomainEventMap["run.settled"]): Promise<void> => {
    if (!settled.conversationId.startsWith(ROUTE_CONVERSATION_PREFIX)) {
        return;
    }
    const owned = await deps.tasks.ownerOf(settled.conversationId);
    if (owned === undefined) {
        return;
    }
    const state = owned.task.state === "stopped" ? "stopped" : settled.failure === undefined ? "finished" : "failed";
    await deps.tasks.moveTask(settled.conversationId, { state, report: settled.closing, ...opt("error", settled.failure) }, nowOf(deps));
};

// The person typing in it themselves, or a re-run: running again.
export const notePersonTurnStarted = async (deps: Pick<PersonTaskDeps, "tasks" | "now">, started: DomainEventMap["run.started"]): Promise<void> => {
    if (!started.conversationId.startsWith(ROUTE_CONVERSATION_PREFIX)) {
        return;
    }
    const owned = await deps.tasks.ownerOf(started.conversationId);
    if (owned === undefined || owned.task.state === "running") {
        return;
    }
    await deps.tasks.moveTask(started.conversationId, { state: "running" }, nowOf(deps));
};
