import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { appendMessage } from "./turnReducer";
import { applyTurnFrame, emptyTurnState, flushPending, revealPending, type TurnEffect, type TurnState } from "./turnReducer";

/* The frame rules, exercised directly. Every one of these used to require driving a whole Conversation — a
 * mocked fetch, an SSE body, a rAF — to observe a decision the reducer now makes in one call. */

// A turn always opens with the user's bubble and an empty assistant bubble (what Conversation.send builds).
const started = (): TurnState => {
    const withUser = appendMessage(emptyTurnState, { role: `user`, text: `do it` });
    const withBubble = appendMessage(withUser, { role: `assistant`, text: ``, thinking: `` });
    return { ...withBubble, bubbleId: withBubble.nextId - 1 };
};
const USER_ID = 1;
const context = { userMessageId: USER_ID };

const run = (state: TurnState, ...events: readonly AgentEvent[]): { state: TurnState; effects: TurnEffect[] } => {
    const effects: TurnEffect[] = [];
    let next = state;
    for (const event of events) {
        const step = applyTurnFrame(next, event, context);
        next = step.state;
        effects.push(...step.effects);
    }
    return { state: next, effects };
};

// Deltas land in the typewriter buffer; most assertions want the transcript AS THE USER WILL SEE IT.
const settled = (state: TurnState): TurnState => flushPending(state);
const textOf = (state: TurnState, id: number): string => settled(state).messages.find((message) => message.id === id)?.text ?? ``;
const assistantTexts = (state: TurnState): string[] =>
    settled(state)
        .messages.filter((message) => message.role === `assistant`)
        .map((message) => message.text);

describe(`prose`, () => {
    it(`types a delta into the turn's open bubble`, () => {
        const { state } = run(started(), { kind: `delta`, text: `hello` });
        expect(textOf(state, 2)).toBe(`hello`);
    });

    it(`drops a sub-agent's prose instead of typing it as the main agent's`, () => {
        // Its final form arrives as the Agent tool's result content; typed into the parent bubble it would read
        // as if the main agent had said it.
        const { state } = run(started(), { kind: `delta`, text: `inner`, parentToolUseId: `t1` });
        expect(textOf(state, 2)).toBe(``);
    });

    it(`ignores an empty delta rather than opening a bubble for it`, () => {
        const { state } = run({ ...started(), bubbleId: null }, { kind: `delta`, text: `` });
        expect(state.messages).toHaveLength(2);
    });

    it(`opens a fresh bubble when the turn's was retired`, () => {
        const { state } = run(started(), { kind: `delta`, text: `first` }, { kind: `text_end` }, { kind: `delta`, text: `second` });
        expect(assistantTexts(state)).toEqual([`first`, `second`]);
    });
});

describe(`text_end`, () => {
    it(`retires a bubble that holds prose, so what follows lands below it`, () => {
        // The interleaving rule: says what it's about to do → the tool cards → what it found. With one bubble
        // per turn the narration glues into a single run with every card hoisted above it.
        const { state } = run(started(), { kind: `delta`, text: `about to read` }, { kind: `text_end` });
        expect(state.bubbleId).toBeNull();
    });

    it(`leaves an empty block's bubble open instead of stranding it`, () => {
        // A model can open a text block and go straight to a tool. Retiring here would leave an empty bubble
        // in the transcript for the rest of the turn.
        const { state } = run(started(), { kind: `text_end` });
        expect(state.bubbleId).toBe(2);
    });

    it(`counts text still buffered in the typewriter as prose`, () => {
        // The delta has been accepted but not yet revealed. Asking the transcript alone would say "empty" and
        // strand the bubble — which is why the buffer is part of the state.
        const { state } = run(started(), { kind: `delta`, text: `queued` });
        expect(state.messages[1]!.text).toBe(``);
        expect(applyTurnFrame(state, { kind: `text_end` }, context).state.bubbleId).toBeNull();
    });

    it(`does not let a sub-agent's block boundary retire the parent's bubble`, () => {
        const { state } = run(started(), { kind: `delta`, text: `parent` }, { kind: `text_end`, parentToolUseId: `t1` });
        expect(state.bubbleId).toBe(2);
    });

    it(`keeps the retired bubble as the buffer's target, so its tail still types out`, () => {
        // Deliberately NOT flushed at the boundary: the closing summary would otherwise snap into place whole.
        const { state } = run(started(), { kind: `delta`, text: `tail` }, { kind: `text_end` });
        expect(state.pending).toEqual({ bubbleId: 2, text: `tail` });
    });

    it(`flushes the previous bubble before typing into a new one`, () => {
        const { state } = run(started(), { kind: `delta`, text: `first` }, { kind: `text_end` }, { kind: `delta`, text: `second` });
        // `first` was flushed into bubble 2 whole; only `second` is still buffering.
        expect(state.messages.find((message) => message.id === 2)?.text).toBe(`first`);
        expect(state.pending?.bubbleId).toBe(3);
    });
});

describe(`thinking`, () => {
    it(`accumulates onto the turn's bubble`, () => {
        const { state } = run(started(), { kind: `thinking`, text: `hmm ` }, { kind: `thinking`, text: `ok` });
        expect(state.messages[1]!.thinking).toBe(`hmm ok`);
    });

    it(`groups a sub-agent's thinking onto its own Agent card`, () => {
        const { state } = run(
            started(),
            { kind: `tool_call`, id: `t1`, name: `Task`, category: `other`, status: `in_progress` },
            { kind: `thinking`, text: `sub`, parentToolUseId: `t1` },
        );
        expect(state.messages[1]!.tools?.[0]?.thinking).toBe(`sub`);
        expect(state.messages[1]!.thinking).toBe(``);
    });
});

describe(`tool calls`, () => {
    it(`nests a sub-agent's calls under the Agent card that spawned them`, () => {
        const { state } = run(
            started(),
            { kind: `tool_call`, id: `t1`, name: `Task`, category: `other`, status: `in_progress` },
            { kind: `tool_call`, id: `t2`, name: `Read`, category: `read`, status: `completed`, parentToolUseId: `t1` },
        );
        expect(state.messages[1]!.tools).toHaveLength(1);
        expect(state.messages[1]!.tools?.[0]?.children?.[0]?.id).toBe(`t2`);
    });

    it(`falls back to a top-level append when the parent card is missing`, () => {
        // A malformed stream: dropping the call outright would lose work the agent actually did.
        const { state } = run(started(), {
            kind: `tool_call`,
            id: `t2`,
            name: `Read`,
            category: `read`,
            status: `completed`,
            parentToolUseId: `gone`,
        });
        expect(state.messages[1]!.tools?.[0]?.id).toBe(`t2`);
    });

    it(`merges an update into the call it belongs to, replacing present fields`, () => {
        // Snapshot semantics, not append: Codex streams a command's growing output as whole snapshots.
        const { state } = run(
            started(),
            { kind: `tool_call`, id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, content: [{ type: `text`, text: `one` }] },
            { kind: `tool_call_update`, id: `t1`, status: `completed`, content: [{ type: `text`, text: `one\ntwo` }] },
        );
        expect(state.messages[1]!.tools?.[0]).toMatchObject({ status: `completed`, content: [{ type: `text`, text: `one\ntwo` }] });
    });

    it(`leaves fields the update omits unchanged`, () => {
        const { state } = run(
            started(),
            { kind: `tool_call`, id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
            { kind: `tool_call_update`, id: `t1`, status: `completed` },
        );
        expect(state.messages[1]!.tools?.[0]?.target).toBe(`ls`);
    });

    it(`reaches a nested call by id`, () => {
        const { state } = run(
            started(),
            { kind: `tool_call`, id: `t1`, name: `Task`, category: `other`, status: `in_progress` },
            { kind: `tool_call`, id: `t2`, name: `Read`, category: `read`, status: `in_progress`, parentToolUseId: `t1` },
            { kind: `tool_call_update`, id: `t2`, status: `completed` },
        );
        expect(state.messages[1]!.tools?.[0]?.children?.[0]?.status).toBe(`completed`);
    });

    it(`drops an update with no matching call rather than showing it loose`, () => {
        const before = started();
        const { state } = run(before, { kind: `tool_call_update`, id: `ghost`, status: `completed` });
        expect(state.messages).toEqual(before.messages);
    });

    it(`hands the caller each tool call so it can record the turn's writes`, () => {
        const { effects } = run(started(), { kind: `tool_call`, id: `t1`, name: `Edit`, category: `edit`, status: `completed` });
        expect(effects).toEqual([expect.objectContaining({ kind: `toolCall` })]);
    });
});

describe(`interactive cards`, () => {
    it(`attaches a plan to the bubble that introduced it and opens a fresh one below`, () => {
        const { state } = run(started(), { kind: `delta`, text: `Here's my plan:` }, { kind: `plan`, requestId: `p1`, text: `# Do it` });
        expect(state.messages[1]!.plan).toMatchObject({ requestId: `p1`, status: `pending` });
        // The intro text finished typing into THIS bubble rather than leaking into the next.
        expect(state.messages[1]!.text).toBe(`Here's my plan:`);
        expect(state.bubbleId).toBeNull();
    });

    it(`streams the post-decision continuation into a bubble below the card`, () => {
        const { state } = run(started(), { kind: `plan`, requestId: `p1`, text: `# Do it` }, { kind: `delta`, text: `working` });
        expect(state.messages).toHaveLength(3);
        expect(state.messages[2]!.plan).toBeUndefined();
        expect(textOf(state, 3)).toBe(`working`);
    });

    it(`treats a question the same way`, () => {
        const { state } = run(started(), { kind: `question`, requestId: `q1`, questions: [] });
        expect(state.messages[1]!.question).toMatchObject({ requestId: `q1`, status: `pending` });
        expect(state.bubbleId).toBeNull();
    });

    it(`carries a permission ask's own fields onto the card`, () => {
        const { state } = run(started(), { kind: `permission`, requestId: `perm1`, toolName: `Bash`, title: `Claude wants to run ls` });
        expect(state.messages[1]!.permission).toMatchObject({ requestId: `perm1`, toolName: `Bash`, status: `pending` });
        // `kind` is wire framing, not part of the ask the card renders.
        expect(state.messages[1]!.permission).not.toHaveProperty(`kind`);
    });
});

/* A card the user answered in ANOTHER window — or in this one, before a reload replayed the run from seq 0 —
 * is decided, and a transcript that rebuilt it from its own frame has no way to know that. The resolution
 * frame is that record, and these are the shapes it has to freeze. */
describe(`resolved cards`, () => {
    const asked = (): TurnState =>
        run(started(), {
            kind: `question`,
            requestId: `q1`,
            questions: [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }],
        }).state;

    it(`freezes an answered question with the picks that settled it`, () => {
        const { state } = run(asked(), {
            kind: `resolved`,
            requestId: `q1`,
            reply: { kind: `question`, requestId: `q1`, answers: { Which: [`A`] } },
        });
        expect(state.messages[1]!.question).toMatchObject({ status: `answered`, answers: { Which: [`A`] } });
    });

    it(`freezes a dismissed question as cancelled`, () => {
        const { state } = run(asked(), { kind: `resolved`, requestId: `q1`, reply: { kind: `question`, requestId: `q1`, cancelled: true } });
        expect(state.messages[1]!.question).toMatchObject({ status: `cancelled` });
    });

    it(`freezes a card nobody answered as cancelled — a turn that died under it is no one's decision`, () => {
        const { state } = run(asked(), { kind: `resolved`, requestId: `q1` });
        expect(state.messages[1]!.question).toMatchObject({ status: `cancelled` });
        expect(state.messages[1]!.question).not.toHaveProperty(`answers`);
    });

    it(`freezes plan and permission cards from the same frame`, () => {
        const { state } = run(
            started(),
            { kind: `plan`, requestId: `p1`, text: `# Do it` },
            { kind: `permission`, requestId: `perm1`, toolName: `Bash` },
            { kind: `resolved`, requestId: `p1`, reply: { kind: `plan`, requestId: `p1`, approve: true } },
            { kind: `resolved`, requestId: `perm1`, reply: { kind: `permission`, requestId: `perm1`, decision: `always` } },
        );
        expect(state.messages[1]!.plan).toMatchObject({ status: `approved` });
        expect(state.messages[2]!.permission).toMatchObject({ status: `always` });
    });

    it(`ignores a resolution for a card this transcript never rendered`, () => {
        const before = asked();
        const { state } = run(before, { kind: `resolved`, requestId: `nobody`, reply: { kind: `plan`, requestId: `nobody`, approve: true } });
        expect(state.messages).toEqual(before.messages);
    });
});

describe(`turn boundaries`, () => {
    it(`attaches usage to the last assistant bubble instead of spawning an empty one`, () => {
        const { state } = run(started(), { kind: `delta`, text: `done` }, { kind: `usage`, costUsd: 0.1, inputTokens: 10 });
        expect(state.messages).toHaveLength(2);
        expect(state.messages[1]!.usage).toEqual({ costUsd: 0.1, inputTokens: 10 });
    });

    it(`retires the bubble at end-of-turn so a steered turn starts below its own user message`, () => {
        const { state } = run(started(), { kind: `usage`, costUsd: 0.1 });
        expect(state.bubbleId).toBeNull();
    });

    it(`flushes the typewriter at end-of-turn so nothing is left mid-type`, () => {
        const { state } = run(started(), { kind: `delta`, text: `finished` }, { kind: `usage` });
        expect(state.pending).toBeUndefined();
        expect(state.messages[1]!.text).toBe(`finished`);
    });

    it(`hands the totals to the caller without the wire's account tag`, () => {
        const { effects } = run(started(), { kind: `usage`, account: `acc-1`, costUsd: 0.25 });
        expect(effects).toEqual([{ kind: `totals`, usage: { costUsd: 0.25 } }]);
    });

    it(`anchors a checkpoint on the turn's user bubble, not the assistant's`, () => {
        const { state } = run(started(), { kind: `checkpoint`, id: `cp-1` });
        expect(state.messages.find((message) => message.id === USER_ID)?.checkpointId).toBe(`cp-1`);
    });
});

describe(`effects`, () => {
    it(`reports session, worktree, mode, model and commands to the caller`, () => {
        const { state, effects } = run(
            started(),
            { kind: `session`, sessionId: `s-1` },
            { kind: `worktree`, branch: `agent/x`, base: `abc123` },
            { kind: `mode`, mode: `plan` },
            { kind: `init`, model: `claude-x` },
            { kind: `commands`, items: [{ name: `review`, description: `Review` }] },
        );
        expect(effects.map((effect) => effect.kind)).toEqual([`session`, `worktree`, `liveMode`, `activeModel`, `commands`]);
        // None of them touched the transcript.
        expect(state.messages).toEqual(started().messages);
    });

    it(`skips account headroom with no account to key it by`, () => {
        // An env-token turn has no account; storing it under `undefined` would show one account's headroom
        // against another's.
        expect(run(started(), { kind: `account_usage`, windows: [] }).effects).toEqual([]);
        expect(run(started(), { kind: `account_usage`, account: `a`, windows: [] }).effects).toHaveLength(1);
    });

    it(`hands an error to the caller rather than phrasing it here`, () => {
        const { effects } = run(started(), { kind: `error`, message: `boom`, code: `rate_limit` });
        expect(effects).toEqual([{ kind: `error`, message: `boom`, code: `rate_limit` }]);
    });

    it(`writes a notice for the frames that speak for themselves`, () => {
        const { state } = run(started(), { kind: `compact`, trigger: `auto` }, { kind: `landed`, landed: true });
        const notices = state.messages.filter((message) => message.role === `notice`);
        expect(notices).toHaveLength(2);
        expect(notices[1]!.text).toContain(`landed`);
    });

    it(`names the repos whose changes could not land`, () => {
        const conflicts = [{ repo: `app`, paths: [{ path: `src/a.ts`, reason: `diverged` as const }], clean: 0 }];
        const { state } = run(started(), { kind: `landed`, landed: false, conflicts });
        expect(state.messages.at(-1)!.text).toContain(`app`);
    });

    it(`offers "keep future work on the branch" on the landed notice, and only there`, () => {
        // The moment the auto-land just fired is when "stop doing that" is worth one press — the same
        // pattern as the outage banner's opt-out. A held or conflicted outcome has nothing to regret, so no offer.
        const landed = run(started(), { kind: `landed`, landed: true });
        expect(landed.state.messages.at(-1)).toMatchObject({ role: `notice`, noticeAction: `landHold` });
        const conflicted = run(started(), { kind: `landed`, landed: false, conflicts: [] });
        expect(conflicted.state.messages.at(-1)!.noticeAction).toBeUndefined();
    });

    it(`says held work stayed on the branch, without calling it landed or conflicted`, () => {
        const { state } = run(started(), { kind: `landed`, landed: false, held: true });
        const notice = state.messages.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`branch`);
        expect(notice.text).not.toContain(`couldn't land`);
        expect(notice.noticeAction).toBeUndefined();
    });
});

describe(`unfamiliar frames`, () => {
    it(`ignores a kind this build has never heard of`, () => {
        // A browser is routinely OLDER than the daemon it talks to. A crash here would take the whole turn down.
        const before = started();
        const step = applyTurnFrame(before, { kind: `future-thing` } as unknown as AgentEvent, context);
        expect(step.state).toBe(before);
        expect(step.effects).toEqual([]);
    });

    it(`treats rate_limit_info and done as no-ops`, () => {
        const before = started();
        const { state, effects } = run(before, { kind: `rate_limit_info`, kindOfLimit: `unknown` } as unknown as AgentEvent, { kind: `done` });
        expect(state).toEqual(before);
        expect(effects).toEqual([]);
    });
});

describe(`typewriter`, () => {
    it(`reveals a slice per tick and finishes exactly`, () => {
        let state = run(started(), { kind: `delta`, text: `abcdefghij` }).state;
        state = revealPending(state);
        expect(state.messages[1]!.text.length).toBeGreaterThan(0);
        expect(state.messages[1]!.text.length).toBeLessThan(10);
        while (state.pending !== undefined) {
            state = revealPending(state);
        }
        expect(state.messages[1]!.text).toBe(`abcdefghij`);
    });

    it(`clears the buffer when there is nothing left, so the caller can stop the loop`, () => {
        let state = run(started(), { kind: `delta`, text: `ab` }).state;
        state = revealPending(state);
        expect(state.pending).toBeUndefined();
    });

    it(`is a no-op with an empty buffer`, () => {
        const state = started();
        expect(revealPending(state)).toBe(state);
    });

    it(`flushes everything at once`, () => {
        const state = flushPending(run(started(), { kind: `delta`, text: `all of it` }).state);
        expect(state.messages[1]!.text).toBe(`all of it`);
        expect(state.pending).toBeUndefined();
    });
});
