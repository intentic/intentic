import { randomInt } from "node:crypto";
import {
    type AgentNeed,
    isOpenNeed,
    NEED_WAIT_DEFAULT_S,
    type Need,
    type NeedAnswer,
    type NeedRaise,
    type NeedRaised,
    type NeedSubject,
    type NeedTold,
    needWakePrompt,
} from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";
import type { Answerer, Met, NeedKinds } from "./need-kinds.js";
import type { NeedsStore } from "./needs-store.js";

// One lifecycle for every need (docs/architecture/needs.md): raise it from an agent's ask, hold the asking call while
// a person may answer, keep it when they do not, check it against the world while it waits, and tell the conversation
// the moment it is met or declined, whether or not its turn is still running.

// Short, since the agent types it back into `needs cancel`; random, so a restart never reissues an id an old row names.
const ID_SPAN = 36 ** 5;
// How often open needs are checked against the world: a connection coming live, a secret appearing, a rebuild landing.
const POLL_MS = 5_000;

// Where a raising call's conversation lives and what a person's answer reaches, by the seams composition hands over.
export interface NeedsDeps {
    readonly store: NeedsStore;
    readonly kinds: NeedKinds;
    readonly logger: Pick<Logger, "info" | "warn" | "error">;
    // The conversation a call raises in: the one its shell names, else the sole live one; undefined refuses.
    readonly raisingConversation: (named: string | undefined) => string | undefined;
    readonly standingOf: (conversationId: string) => TurnStanding | undefined;
    // Whether a turn is running on the conversation right now.
    readonly isLive: (conversationId: string) => boolean;
    // Draws the need in the running turn's transcript; a no-op when nothing runs.
    readonly draw: (conversationId: string, need: Need) => void;
    // Tells the conversation's card what it still waits on.
    readonly show: (conversationId: string, needs: readonly AgentNeed[]) => void;
    // The owner's devices, when nobody is looking.
    readonly notify: (need: Need) => void;
    // Words into the live turn only: false when nothing steerable runs, and then nothing starts.
    readonly steer: (conversationId: string, prompt: string) => Promise<boolean>;
    // Words into the live turn, a turn of their own, or queued behind what runs; undefined when they went nowhere.
    readonly wake: (conversationId: string, prompt: string) => Promise<NeedTold | undefined>;
    // Whether a met need continues its conversation by itself (Sandbox ▸ Agent ▸ needs).
    readonly continueWhenMet: () => Promise<boolean>;
    // Stores a secret need's value where its reference resolves (kinds/secret-need.ts `provide`).
    readonly provideSecret: (need: Need, value: string) => Promise<Met>;
    // Subscribes to a conversation's turn ending; answers the unsubscribe.
    readonly onTurnEnded: (listener: (conversationId: string) => void) => () => void;
    readonly now?: () => number;
    readonly pollMs?: number;
    readonly newId?: () => string;
}

export interface NeedAskInput {
    readonly raise: NeedRaise;
    // The conversation the calling shell names (its x-intentic-conversation header).
    readonly conversationId: string | undefined;
    // The call's own lifetime; its abort ends the hold, never the need.
    readonly signal: AbortSignal;
}

export class NeedRefusal extends Error {
    override name = "NeedRefusal";
    constructor(
        readonly code: "not_found" | "not_yours" | "closed" | "invalid" | "forbidden",
        message: string,
    ) {
        super(message);
    }
}

export interface Needs {
    readonly ask: (input: NeedAskInput) => Promise<NeedRaised>;
    readonly mine: (conversationId: string | undefined) => Promise<readonly Need[]>;
    readonly withdraw: (id: string, conversationId: string | undefined) => Promise<Need>;
    readonly list: (query: { readonly conversationId?: string | undefined; readonly open?: boolean | undefined }) => Promise<readonly Need[]>;
    readonly get: (id: string) => Promise<Need | undefined>;
    readonly answer: (id: string, answer: NeedAnswer, by: Answerer) => Promise<Need>;
    // A secret's value for a secret need: stored by its kind where the reference resolves it, and the need met.
    readonly provide: (id: string, value: string, by: Answerer) => Promise<Need>;
    // Something outside changed (a capability saved, a secret added): check open needs now rather than at the next tick.
    readonly recheck: () => void;
    // A need the harness saw asked outside the needs door (the person's own browser's `ask_access`): drawn like any
    // other, never held, since the call that asked has its own answer. An open one with the same subject is returned.
    readonly observe: (conversationId: string, subject: NeedSubject, title: string, why?: string) => Promise<Need>;
    // Boot: tell every card what it waits on, deliver answers a restart interrupted, start checking. Answers the stop.
    readonly start: () => () => void;
}

const agentNeed = (need: Need): AgentNeed => ({ id: need.id, kind: need.subject.kind, title: need.title, status: need.status });

const openAsk = (need: Need, unattended: boolean): string =>
    [
        `Asked a person: ${need.title} (need ${need.id}).`,
        unattended
            ? "This turn is unattended, so nobody will answer while it runs: carry on with everything that does not need it, and say plainly what is waiting on it."
            : "They have not answered yet. Carry on with everything that does not need it.",
        "The answer reaches this conversation by itself, so do not poll and do not ask again. `needs` lists what is still waiting; `needs cancel " +
            `${need.id}\` withdraws it if the task stops needing it.`,
    ].join(" ");

export const createNeeds = (deps: NeedsDeps): Needs => {
    const now = deps.now ?? Date.now;
    const newId = deps.newId ?? ((): string => `need-${randomInt(ID_SPAN).toString(36).padStart(5, "0")}`);
    // Raising calls holding for their need's answer, by need id; settling one hands each the need (and, when met, what
    // the agent can do with it) and tells nobody else.
    const holding = new Map<string, Set<(need: Need, met: Met | undefined) => void>>();
    // Met needs that reach the agent only on a next turn, by conversation, delivered when its current turn ends.
    const afterTurn = new Map<string, Set<string>>();

    const publish = async (conversationId: string): Promise<void> => {
        const open = (await deps.store.all())
            .filter((need) => need.conversationId === conversationId && isOpenNeed(need))
            .sort((left, right) => left.createdAt - right.createdAt);
        deps.show(conversationId, open.map(agentNeed));
    };

    const told = async (need: Need, how: NeedTold | undefined): Promise<void> => {
        if (how !== undefined) {
            await deps.store.update(need.id, (current) => ({ ...current, told: how }));
        }
    };

    const promptOf = (need: Need, outcome: "met" | "declined", met: Met | undefined): string =>
        needWakePrompt({
            outcome,
            id: need.id,
            title: need.title,
            why: need.why,
            result: met?.result ?? need.outcome ?? "",
            use: met?.use ?? [],
        });

    // Tells the conversation how a need ended, when no call is holding for it. A decline only reaches a live turn: a
    // finished conversation is not woken to hear a no.
    const deliver = async (need: Need, met: Met | undefined): Promise<void> => {
        if (need.status === "declined") {
            const steered = await deps.steer(need.conversationId, promptOf(need, "declined", undefined));
            await told(need, steered ? "turn" : undefined);
            return;
        }
        if (need.status !== "met") {
            return;
        }
        if (!(await deps.continueWhenMet())) {
            return;
        }
        if (deps.kinds[need.subject.kind].nextTurn(need) && deps.isLive(need.conversationId)) {
            const waiting = afterTurn.get(need.conversationId) ?? new Set<string>();
            waiting.add(need.id);
            afterTurn.set(need.conversationId, waiting);
            return;
        }
        const how = await deps.wake(need.conversationId, promptOf(need, "met", met));
        await told(need, how);
    };

    // Settles a need met or declined, whichever door it came through, exactly once.
    const settle = async (id: string, status: "met" | "declined" | "cancelled", outcome: string, by: Answerer | undefined, met?: Met): Promise<Need> => {
        let settled: Need | undefined;
        await deps.store.update(id, (need) => {
            if (!isOpenNeed(need)) {
                return need;
            }
            settled = {
                ...need,
                status,
                outcome,
                updatedAt: now(),
                ...(by?.email === undefined ? {} : { answeredBy: by.email }),
            };
            return settled;
        });
        const need = settled ?? (await deps.store.get(id));
        if (need === undefined) {
            throw new NeedRefusal("not_found", `No need is named "${id}".`);
        }
        if (settled === undefined) {
            return need;
        }
        await publish(need.conversationId);
        const waiters = holding.get(id);
        if (waiters !== undefined && waiters.size > 0) {
            holding.delete(id);
            for (const waiter of waiters) {
                waiter(need, met);
            }
            await told(need, "call");
        } else if (status !== "cancelled") {
            await deliver(need, met).catch((error: unknown) => deps.logger.warn({ err: error, need: id }, "needs: could not tell the conversation"));
        }
        return need;
    };

    // What a met need's answer tells the agent, freshly: the kind's own sentence when it can say it, else the stored one.
    const metOf = async (need: Need): Promise<Met> =>
        (await deps.kinds[need.subject.kind].check(need).catch(() => undefined)) ?? { result: need.outcome ?? "It is done.", use: [] };

    const checking = { running: false };
    const checkOpen = async (): Promise<void> => {
        if (checking.running) {
            return;
        }
        checking.running = true;
        try {
            for (const need of (await deps.store.all()).filter(isOpenNeed)) {
                const met = await deps.kinds[need.subject.kind].check(need).catch((error: unknown) => {
                    deps.logger.warn({ err: error, need: need.id }, "needs: a check failed; it stays open");
                    return undefined;
                });
                if (met !== undefined) {
                    await settle(need.id, "met", met.result, undefined, met);
                }
            }
        } finally {
            checking.running = false;
        }
    };

    // Holds a raising call up to `seconds` for the need to settle; answers the need as it then stands, with what a met
    // one's answer said the agent can do with it.
    const hold = (need: Need, seconds: number, signal: AbortSignal): Promise<{ readonly need: Need; readonly met?: Met | undefined }> =>
        seconds === 0
            ? Promise.resolve({ need })
            : new Promise((resolve) => {
                  const waiters = holding.get(need.id) ?? new Set<(settled: Need, met: Met | undefined) => void>();
                  holding.set(need.id, waiters);
                  const done = (settled: Need, met: Met | undefined): void => {
                      clearTimeout(timer);
                      signal.removeEventListener("abort", letGo);
                      waiters.delete(done);
                      resolve({ need: settled, met });
                  };
                  // The hold ran out or the call went away: the need stays up, and this call answers it as open.
                  const letGo = (): void => done(need, undefined);
                  const timer = setTimeout(letGo, seconds * 1_000);
                  signal.addEventListener("abort", letGo, { once: true });
                  waiters.add(done);
              });

    const answered = async (need: Need, given?: Met): Promise<NeedRaised> => {
        if (need.status === "met") {
            const met = given ?? (await metOf(need));
            return { state: "met", need, message: [met.result, ...met.use].join(" ") };
        }
        if (need.status === "declined") {
            return {
                state: "refused",
                code: "declined",
                need,
                message: `A person declined: ${need.title}.${need.outcome === undefined ? "" : ` ${need.outcome}`} Carry on without it, say plainly what it would have enabled, and do not ask for it again in this conversation.`,
            };
        }
        return { state: "open", need, message: openAsk(need, false) };
    };

    const ask = async ({ raise, conversationId: named, signal }: NeedAskInput): Promise<NeedRaised> => {
        const conversationId = deps.raisingConversation(named);
        if (conversationId === undefined) {
            return {
                state: "refused",
                code: "no_conversation",
                message: "A need is raised in the conversation this shell belongs to, and none could be found. Nothing was asked.",
            };
        }
        const standing = deps.standingOf(conversationId);
        const handler = deps.kinds[raise.ask.kind];
        const resolved = await handler.resolve(raise.ask, { conversationId, standing });
        if (resolved.kind === "met") {
            return { state: "met", message: resolved.message };
        }
        if (resolved.kind === "refused") {
            return { state: "refused", code: resolved.code, message: resolved.message };
        }
        const key = deps.kinds[resolved.subject.kind].key(resolved.subject);
        const earlier = (await deps.store.all()).find(
            (need) => need.conversationId === conversationId && need.subject.kind === resolved.subject.kind && deps.kinds[need.subject.kind].key(need.subject) === key,
        );
        if (earlier?.status === "declined") {
            return answered(earlier);
        }
        const unattended = standing?.unattended === true;
        const seconds = unattended ? 0 : (raise.wait ?? NEED_WAIT_DEFAULT_S);
        if (earlier !== undefined && isOpenNeed(earlier)) {
            // The same ask again: the first one is still up, so this call waits on it rather than raising a second.
            const held = await hold(earlier, seconds, signal);
            return answered(held.need, held.met);
        }
        const at = now();
        const need: Need = {
            id: newId(),
            conversationId,
            subject: resolved.subject,
            title: resolved.title,
            ...(raise.why === undefined || raise.why === "" ? {} : { why: raise.why.slice(0, 280) }),
            status: "open",
            createdAt: at,
            updatedAt: at,
            ...(unattended ? { unattended: true } : {}),
        };
        await deps.store.put(need);
        deps.draw(conversationId, need);
        await publish(conversationId);
        deps.notify(need);
        // Something may already have met it between resolving and now (the person had the form open).
        void checkOpen();
        const held = await hold(need, seconds, signal);
        if (!isOpenNeed(held.need)) {
            return answered(held.need, held.met);
        }
        return { state: "open", need: held.need, message: openAsk(held.need, unattended) };
    };

    const ownedBy = async (id: string, conversationId: string | undefined): Promise<Need> => {
        const need = await deps.store.get(id);
        if (need === undefined) {
            throw new NeedRefusal("not_found", `No need is named "${id}": \`needs\` lists this conversation's.`);
        }
        const asking = deps.raisingConversation(conversationId);
        if (asking !== undefined && need.conversationId !== asking) {
            throw new NeedRefusal("not_yours", `"${id}" was raised by another conversation, so it is not this one's to withdraw.`);
        }
        return need;
    };

    const answer = async (id: string, reply: NeedAnswer, by: Answerer): Promise<Need> => {
        const need = await deps.store.get(id);
        if (need === undefined) {
            throw new NeedRefusal("not_found", `No need is named "${id}".`);
        }
        if (!isOpenNeed(need)) {
            throw new NeedRefusal("closed", `That need is already ${need.status}: ${need.outcome ?? need.title}.`);
        }
        const refusedBy = deps.kinds[need.subject.kind].mayAnswer?.(need, by);
        if (refusedBy !== undefined) {
            throw new NeedRefusal("forbidden", refusedBy);
        }
        if (reply.kind === "decline") {
            const handler = deps.kinds[need.subject.kind];
            await handler.declined?.(need);
            const note = reply.note?.trim();
            return settle(id, "declined", note === undefined || note === "" ? "" : `They said: ${note}`, by);
        }
        const outcome = await deps.kinds[need.subject.kind].answer(need, reply, by);
        if ("refused" in outcome) {
            throw new NeedRefusal("forbidden", outcome.refused);
        }
        if (outcome.status === "working") {
            const moved = await deps.store.update(id, (current) => ({
                ...current,
                status: "working",
                updatedAt: now(),
                ...(outcome.subject === undefined ? {} : { subject: outcome.subject }),
                ...(by.email === undefined ? {} : { answeredBy: by.email }),
            }));
            await publish(need.conversationId);
            void checkOpen();
            return moved ?? need;
        }
        if (outcome.status === "declined") {
            return settle(id, "declined", outcome.result, by);
        }
        return settle(id, "met", outcome.result, by, outcome);
    };

    return {
        ask,
        mine: async (conversationId) => {
            const asking = deps.raisingConversation(conversationId);
            return asking === undefined ? [] : (await deps.store.all()).filter((need) => need.conversationId === asking);
        },
        withdraw: async (id, conversationId) => {
            const need = await ownedBy(id, conversationId);
            if (!isOpenNeed(need)) {
                return need;
            }
            return settle(id, "cancelled", "The agent withdrew it: the task no longer needs it.", undefined);
        },
        list: async ({ conversationId, open }) =>
            (await deps.store.all()).filter(
                (need) => (conversationId === undefined || need.conversationId === conversationId) && (open !== true || isOpenNeed(need)),
            ),
        get: (id) => deps.store.get(id),
        answer,
        provide: async (id, value, by) => {
            const need = await deps.store.get(id);
            if (need === undefined) {
                throw new NeedRefusal("not_found", `No need is named "${id}".`);
            }
            if (!isOpenNeed(need)) {
                throw new NeedRefusal("closed", `That need is already ${need.status}: ${need.outcome ?? need.title}.`);
            }
            if (need.subject.kind !== "secret") {
                throw new NeedRefusal("invalid", "Only a secret need takes a value.");
            }
            const met = await deps.provideSecret(need, value);
            return settle(id, "met", met.result, by, met);
        },
        recheck: () => void checkOpen(),
        observe: async (conversationId, subject, title, why) => {
            const key = deps.kinds[subject.kind].key(subject);
            const earlier = (await deps.store.all()).find(
                (need) => need.conversationId === conversationId && need.subject.kind === subject.kind && isOpenNeed(need) && deps.kinds[need.subject.kind].key(need.subject) === key,
            );
            if (earlier !== undefined) {
                return earlier;
            }
            const at = now();
            const need: Need = {
                id: newId(),
                conversationId,
                subject,
                title,
                ...(why === undefined || why === "" ? {} : { why: why.slice(0, 280) }),
                status: "open",
                createdAt: at,
                updatedAt: at,
                ...(deps.standingOf(conversationId)?.unattended === true ? { unattended: true } : {}),
            };
            await deps.store.put(need);
            deps.draw(conversationId, need);
            await publish(conversationId);
            deps.notify(need);
            void checkOpen();
            return need;
        },
        start: () => {
            const unsubscribe = deps.onTurnEnded((conversationId) => {
                const waiting = afterTurn.get(conversationId);
                if (waiting === undefined) {
                    return;
                }
                afterTurn.delete(conversationId);
                void (async () => {
                    for (const id of waiting) {
                        const need = await deps.store.get(id);
                        if (need?.status === "met" && need.told === undefined) {
                            await told(need, await deps.wake(conversationId, promptOf(need, "met", await metOf(need))));
                        }
                    }
                })().catch((error: unknown) => deps.logger.warn({ err: error, conversationId }, "needs: could not continue the conversation"));
            });
            void (async () => {
                const needs = await deps.store.all();
                for (const conversationId of new Set(needs.filter(isOpenNeed).map((need) => need.conversationId))) {
                    await publish(conversationId);
                }
                // Answered while the daemon was down, or met by the restart itself (a rebuild): said now.
                for (const need of needs.filter((entry) => entry.status === "met" && entry.told === undefined)) {
                    await deliver(need, await metOf(need));
                }
                await checkOpen();
            })().catch((error: unknown) => deps.logger.error({ err: error }, "needs: the boot pass failed"));
            const timer = setInterval(() => void checkOpen(), deps.pollMs ?? POLL_MS);
            timer.unref();
            return () => {
                clearInterval(timer);
                unsubscribe();
            };
        },
    };
};
