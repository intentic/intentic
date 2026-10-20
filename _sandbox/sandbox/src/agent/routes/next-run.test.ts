import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { startTurnRun, TurnRun } from "../run/turn/turn-runs.js";
import type { BeginRefusal } from "../../conversations/actor/conversation-decide.js";
import { nextRunAfter, runToAttach } from "./next-run.js";

// An attach `after` a run the reader saw end waits for the conversation's next one, which its queue starts a moment
// later, instead of the reader asking again on a timer.

const fleet = (): Parameters<typeof nextRunAfter>[0] & Parameters<typeof startTurnRun>[0] => ({
    conversations: memoryFleet().conversations,
    events: createDomainEvents(() => {}),
});

// A turn that ends as soon as it is asked.
const ends: TurnStarter["stream"] = async function* () {
    yield { kind: `done` } satisfies AgentEvent;
};

// A turn that runs until its test is over.
const runs: TurnStarter["stream"] = async function* () {
    await new Promise(() => {});
    yield { kind: `done` } satisfies AgentEvent;
};

const started = (run: TurnRun | BeginRefusal): TurnRun => {
    if (!(run instanceof TurnRun)) {
        throw new Error(`the start was refused: ${run}`);
    }
    return run;
};

const QUICK = { waitMs: 300, pollMs: 20 };

describe(`the run after one a reader saw end`, () => {
    it(`is the conversation's run at once when it is already another`, async () => {
        const deps = fleet();
        const run = started(startTurnRun(deps, runs, { prompt: `go`, conversationId: `c-now` }));
        expect(await nextRunAfter(deps, `c-now`, `an-older-run`, undefined, QUICK)).toBe(run);
    });

    it(`waits for the next run to start, and is told it by the start's announcement`, async () => {
        const deps = fleet();
        const first = started(startTurnRun(deps, ends, { prompt: `one`, conversationId: `c-next` }));
        await first.waitUntilRecorded();
        // A wait far past the test's own: only the announcement can answer it in time.
        const next = nextRunAfter(deps, `c-next`, first.id, undefined, { waitMs: 60_000, pollMs: 60_000 });
        const second = started(startTurnRun(deps, runs, { prompt: `two`, conversationId: `c-next` }));
        deps.events.publish(`run.started`, { conversationId: `c-next`, speaker: undefined, resume: undefined, errand: undefined });
        expect(await next).toBe(second);
    });

    it(`finds a run nobody announced by looking again`, async () => {
        const deps = fleet();
        const first = started(startTurnRun(deps, ends, { prompt: `one`, conversationId: `c-quiet` }));
        await first.waitUntilRecorded();
        const next = nextRunAfter(deps, `c-quiet`, first.id, undefined, QUICK);
        const second = started(startTurnRun(deps, runs, { prompt: `two`, conversationId: `c-quiet` }));
        expect(await next).toBe(second);
    });

    it(`is nothing once the wait runs out, or the reader goes`, async () => {
        const deps = fleet();
        const first = started(startTurnRun(deps, ends, { prompt: `one`, conversationId: `c-none` }));
        await first.waitUntilRecorded();
        expect(await nextRunAfter(deps, `c-none`, first.id, undefined, QUICK)).toBeUndefined();
        expect(await nextRunAfter(deps, `c-never`, `any`, undefined, QUICK)).toBeUndefined();
        const gone = new AbortController();
        const waiting = nextRunAfter(deps, `c-none`, first.id, gone.signal, { waitMs: 60_000, pollMs: 60_000 });
        gone.abort();
        expect(await waiting).toBeUndefined();
    });

    it(`leaves an attach without \`after\` as it was: the newest run, or none`, async () => {
        const deps = fleet();
        expect(await runToAttach(deps, `c-plain`, undefined)).toBeUndefined();
        const first = started(startTurnRun(deps, ends, { prompt: `one`, conversationId: `c-plain` }));
        await first.waitUntilRecorded();
        expect(await runToAttach(deps, `c-plain`, undefined)).toBe(first);
    });
});
