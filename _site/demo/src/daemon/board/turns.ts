import type { AgentEvent, AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { Frames, refuse } from "@intentic/contract-serve";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { homeStoryOf } from "../../fixture/home/recording";
import { transcriptFor } from "../../fixture/transcripts";
import type { HomeSandbox } from "../../fixture/home/sandboxes";
import { homeRecording } from "../../mode";
import { createRun, featuredRun, type Run, visitorRun } from "../../turn";
import { followHomeTurn } from "./homeCards";
import { AWAITING_ID, broadcastRoster, FEATURED_ID, patchAgent, roster } from "./roster";

// The runs a visitor can start, watch, answer and stop: one live Run per conversation, attached as the frame stream
// the real daemon answers with.

const runs = new Map<string, Run>();

// A home conversation has the same id in every sandbox (it is named after its person), so its run is the one sandbox's.
const runKey = (conversationId: string, sandbox: HomeSandbox): string => (isHomeConversationId(conversationId) ? `${sandbox}/${conversationId}` : conversationId);

// What hears a home conversation's turn: its sandbox's own home card (homeCards.ts), sent out whenever it moves. Nothing
// else's turn has a card of its own per sandbox.
const homeWatch = (conversationId: string, sandbox: HomeSandbox): ((event: AgentEvent) => void) | undefined =>
    homeRecording && isHomeConversationId(conversationId)
        ? (event) => {
              if (followHomeTurn(sandbox, event, Date.now())) {
                  broadcastRoster();
              }
          }
        : undefined;

/** The recorded turn a conversation plays, created on first attach so its clock starts when the visitor actually arrives. */
const runFor = (conversationId: string, sandbox: HomeSandbox): Run | undefined => {
    const key = runKey(conversationId, sandbox);
    const existing = runs.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const now = Date.now();
    const story = homeRecording && isHomeConversationId(conversationId) ? homeStoryOf(sandbox) : undefined;
    const run =
        story === undefined
            ? conversationId === FEATURED_ID
                ? featuredRun(conversationId, now)
                : undefined
            : createRun(conversationId, story.prompt, story.beats, now, homeWatch(conversationId, sandbox));
    if (run !== undefined) {
        runs.set(key, run);
    }
    return run;
};

export const attach = (conversationId: string, sandbox: HomeSandbox): Frames<AttachFrame> => {
    const run = runFor(conversationId, sandbox);
    if (run === undefined) {
        // Nothing is running on this conversation, the same empty stream a real daemon answers with.
        return new Frames((sink) => {
            sink.emit({ kind: `end` });
            sink.close();
            return () => {};
        });
    }
    return new Frames((sink) => {
        run.attach(sink);
        return () => {};
    });
};

export const startTurn = ({ conversationId = FEATURED_ID, prompt }: SandboxHandlerInput<`agent`, `run`>, sandbox: HomeSandbox = `shop`): { delivered: `started`; run: string } => {
    const key = runKey(conversationId, sandbox);
    runs.get(key)?.stop();
    const run = visitorRun(conversationId, prompt, Date.now(), homeWatch(conversationId, sandbox));
    runs.set(key, run);
    // As the daemon derives them (agents-registry summaryOf): a live turn has nothing parked, and a refused land's flag
    // and causes follow the `conflict` status the turn replaces, so they go with it.
    patchAgent(conversationId, {
        status: `running`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        conflictCauses: undefined,
        // The turn that opens a fresh session is the one a fresh start or a cleared history was waiting for.
        freshPending: undefined,
        failureCode: undefined,
        failure: undefined,
        limitHeld: undefined,
    });
    return { delivered: `started`, run: run.id };
};

// What a held turn was asked, read off the record: the newest words a person sent it, else what the card is called.
const heldPrompt = (card: AgentSummary): string =>
    transcriptFor(card.id, `shop`).messages.findLast((row) => row.role === `user`)?.text ?? card.title ?? `Continue.`;

// A turn the card holds after a refusal, a failure or a stop: what `resume` and a hand-off choice act on.
const heldCard = (conversationId: string): AgentSummary => {
    const card = roster.agents.find((agent) => agent.id === conversationId) ?? refuse(`No such conversation.`, 404);
    if (card.status === `running`) {
        return refuse(`A turn is already running in this conversation.`, 409);
    }
    if (card.limitHeld !== true && card.status !== `error` && card.status !== `stopped`) {
        return refuse(`Nothing is held in this conversation to run again.`, 404);
    }
    return card;
};

// The same turn again, on whoever the routing names now: the usual answer to a spent allowance.
export const resumeTurn = ({ conversationId, routing }: SandboxHandlerInput<`agent`, `resume`>, sandbox: HomeSandbox = `shop`): SandboxHandlerOutput<`agent`, `resume`> => {
    const card = heldCard(conversationId);
    if (routing !== undefined) {
        patchAgent(conversationId, { provider: routing.agent, harness: routing.harness, model: routing.model ?? card.model, account: routing.account ?? card.account });
    }
    return { run: startTurn({ conversationId, prompt: heldPrompt(card) }, sandbox).run };
};

// How the held turn continues once it is sent again; starts nothing.
export const chooseHandoff = ({ conversationId }: SandboxHandlerInput<`agent`, `chooseHandoff`>): SandboxHandlerOutput<`agent`, `chooseHandoff`> => {
    heldCard(conversationId);
    return { ok: true };
};

export const reply = (answer: SandboxHandlerInput<`agent`, `reply`>): { ok: true } => {
    for (const run of runs.values()) {
        run.resolve(answer.requestId, answer);
    }
    // The card that was parked belongs to the agent whose attention flag raised it: answering clears it.
    patchAgent(AWAITING_ID, {
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    return { ok: true };
};

export const stopTurn = ({ conversationId }: SandboxHandlerInput<`agent`, `stop`>, sandbox: HomeSandbox = `shop`): { stopped: boolean } => {
    const run = runs.get(runKey(conversationId, sandbox));
    run?.stop();
    homeWatch(conversationId, sandbox)?.({ kind: `done` });
    patchAgent(conversationId, { status: `stopped`, updatedAt: Date.now() });
    return { stopped: run !== undefined };
};
