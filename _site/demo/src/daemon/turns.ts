import type { AgentEvent, AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import type { SandboxHandlerInput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { Frames, refuse } from "@intentic/contract-serve";
import { HOME_STORIES } from "../fixture/home/recording";
import type { HomeSandbox } from "../fixture/home/sandboxes";
import { homeRecording } from "../mode";
import { createRun, featuredRun, type Run, visitorRun } from "../turn";
import { followHomeTurn } from "./homeCards";
import { AWAITING_ID, broadcastRoster, FEATURED_ID, patchAgent } from "./roster";

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
    const story = homeRecording && isHomeConversationId(conversationId) ? HOME_STORIES[sandbox] : undefined;
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

// Prefixes for the rail's isolated extension runs (xt-/dg-/mt-), refused here; a prefixless run still works.
const EXTENSION_RUN_PREFIXES = [`xt-`, `dg-`, `mt-`];

export const startTurn = ({ conversationId = FEATURED_ID, prompt }: SandboxHandlerInput<`agent`, `run`>, sandbox: HomeSandbox = `shop`): { delivered: `started`; run: string } => {
    if (EXTENSION_RUN_PREFIXES.some((prefix) => conversationId.startsWith(prefix))) {
        return refuse(`This is the demo workspace: a run needs your repositories and a sandbox to walk them in. Start one and this button works.`);
    }
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
    });
    return { delivered: `started`, run: run.id };
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
