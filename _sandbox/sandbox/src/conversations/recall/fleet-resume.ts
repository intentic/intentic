import { RESUME_NOTES } from "@intentic/sandbox-contract/events/resume";
import { type AgentHarness, type AgentProvider, DEFAULT_PROVIDER, profileOf } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../composition.js";
import type { StartedRun } from "../../seams/turn-starter.js";
import { opt } from "../../opt.js";
import { conversationProfile, type PersistedAgent } from "../registry/agents-store.js";
import { sessionFor } from "../registry/routing.js";
import { resolveHandle } from "./fleet-recall.js";

// One agent pressing another conversation's Continue: the editor's "Send again" on a turn a spent allowance or a stop
// held, or its Continue on one that simply ended, from a shell. Until 2026-10-19 an agent could only put words in front
// of another conversation (fleet-message.ts), which started a fresh turn on that conversation's own routing: a turn held
// on a spent account went straight back to the same wall, the held request itself was never re-run, and the words
// arrived as a stranger's. Three automation runs sat behind one press nobody in the sandbox could make.
//
// It is the press itself, through the same two seams the editor's buttons reach (services.turns): a held turn runs again
// whole with its own resume note (`resume`, turn-resume.ts fireHeldResume) on the routing named here or the
// conversation's own; with nothing held, the conversation carries on in its own session with the `continued` note and
// no words (`start`, as carryOnTurn does). Nothing is said in anyone's name, so nothing taints the turn. Same reach as
// `message`: what an agent token may already start a turn on.

/** Where the re-run goes: absent fields keep the conversation's own. */
export interface ResumeAsk {
    readonly provider?: AgentProvider | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly model?: string | undefined;
    readonly account?: string | undefined;
    readonly effort?: string | undefined;
}

export type ResumeRefusal = 400 | 404 | 409;

export type ResumeOutcome =
    | {
          readonly ok: true;
          readonly to: string;
          readonly run: string;
          // What the press found: a held turn sent again, or an ended one carried on.
          readonly resumed: "held" | "continued";
          readonly on: { readonly provider: AgentProvider; readonly model?: string | undefined; readonly account?: string | undefined };
      }
    | { readonly ok: false; readonly status: ResumeRefusal; readonly message: string; readonly candidates?: readonly PersistedAgent[] };

type Refused = Extract<ResumeOutcome, { ok: false }>;

const targetOf = (services: Services, from: string | undefined, handle: string): PersistedAgent | Refused => {
    const resolved = resolveHandle(services, handle);
    if (resolved.kind === "ambiguous") {
        return {
            ok: false,
            status: 409,
            message: `\`${handle}\` matches ${resolved.candidates.length} conversations; name one of them.`,
            candidates: resolved.candidates,
        };
    }
    if (resolved.kind === "unknown") {
        return { ok: false, status: 404, message: `No conversation answers to \`${handle}\`. Search for one with \`agents find "<text>"\`.` };
    }
    if (resolved.entry.id === from) {
        return { ok: false, status: 400, message: "That is this conversation, and it is running: there is nothing to resume." };
    }
    if (resolved.entry.archivedAt !== undefined) {
        return {
            ok: false,
            status: 409,
            message: `\`${resolved.entry.id}\` is archived: it is off the board, and resuming it would quietly start work on it. Ask the owner to reopen it first.`,
        };
    }
    return resolved.entry;
};

/**
 * The routing the press carries: the conversation's own, with what the ask names laid over it. A move to another
 * provider drops the old provider's account and loop, since neither means anything there.
 */
export const pressRouting = (entry: PersistedAgent, ask: ResumeAsk) => {
    const own = conversationProfile(entry);
    const moving = ask.provider !== undefined && ask.provider !== own.agent;
    return profileOf({
        ...own,
        agent: ask.provider ?? own.agent,
        harness: ask.harness ?? (moving ? undefined : own.harness),
        model: ask.model ?? (moving ? undefined : own.model),
        account: ask.account ?? (moving ? undefined : own.account),
        // The old model's tier settings may not exist on the new one.
        effort: ask.effort ?? (moving || ask.model !== undefined ? undefined : own.effort),
        thinking: moving || ask.model !== undefined ? undefined : own.thinking,
        fast: moving || ask.model !== undefined ? undefined : own.fast,
    });
};

// The press's routing as a held turn's re-run takes it: provider and loop always named, the rest only where set.
const heldRouting = (routing: ReturnType<typeof pressRouting>) => ({
    agent: routing.agent ?? DEFAULT_PROVIDER,
    harness: routing.harness ?? "native",
    ...opt("account", routing.account),
    ...opt("model", routing.model),
    ...opt("effort", routing.effort),
});

// A conversation with nothing held goes on in the session it continues, with the `continued` note as the whole prompt:
// the presser wrote nothing, so nothing is recorded as anyone's words. Undefined when a turn took it first.
const carryOn = async (services: Services, conversationId: string, routing: ReturnType<typeof pressRouting>, from: string | undefined): Promise<StartedRun | undefined> => {
    const started = await services.turns.start({
        ...routing,
        conversationId,
        prompt: RESUME_NOTES.continued,
        resume: "continued",
        // Who pressed, in the vocabulary the registry uses for a spawned child's starter.
        actor: `agent:${from ?? "(unstamped)"}`,
        ...opt("sessionId", sessionFor(services, { ...routing, conversationId })),
    });
    return started === "busy" || started === "archived" ? undefined : started;
};

/** `from` is the pressing conversation, absent for a shell with no turn stamp. */
export const resumeConversation = async (services: Services, from: string | undefined, handle: string, ask: ResumeAsk = {}): Promise<ResumeOutcome> => {
    const entry = targetOf(services, from, handle);
    if ("ok" in entry) {
        return entry;
    }
    const state = services.conversations.state(entry.id);
    if (state?.phase.kind === "running") {
        return { ok: false, status: 409, message: `\`${entry.id}\` is running a turn already: follow it with \`agents show ${entry.id}\`.` };
    }
    const held = state?.resume.held;
    // A sign-in being renewed is the owner's to finish; the re-run seam refuses it too, this only says why.
    if (held?.reason === "auth") {
        return {
            ok: false,
            status: 409,
            message: `\`${entry.id}\` is waiting on a sign-in the owner has to renew; no press runs it before that.`,
        };
    }
    const routing = pressRouting(entry, ask);
    const started = held === undefined ? await carryOn(services, entry.id, routing, from) : await services.turns.resume(entry.id, heldRouting(routing));
    if (started === undefined) {
        return { ok: false, status: 409, message: `\`${entry.id}\` would not take a turn right now: a turn may have started there since. Look again.` };
    }
    services.logger.info({ from, to: entry.id, run: started.id, held: held?.reason }, "fleet resume: pressed Continue on another conversation");
    return {
        ok: true,
        to: entry.id,
        run: started.id,
        resumed: held === undefined ? "continued" : "held",
        on: { provider: routing.agent ?? entry.profile.provider, model: routing.model, account: routing.account },
    };
};
