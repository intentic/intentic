import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { TURN_CHECKS_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import type { AgentRequest, TurnHooks } from "../../agent/providers/agent-request.js";
import type { EditReviewer } from "../../agent/verification/agent-diagnostics.js";
import type { TurnChecks } from "../../agent/run/turn-checks.js";
import { declarationOf, rulesOf } from "../../rules/repo-checks.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { type TurnEnding, withEndingChecks } from "./ending-checks.js";

// What every loop hears as its turn ends: the repositories' turn checks, and the owner's edit checks on the files a loop
// with no hook after a call edited, said back once as one more prompt on the session the run ended on.

const cards = parkedCards(memoryFleet().conversations);
const [TURN_CHECK] = rulesOf(declarationOf("intentic", [{ when: "turn", run: "node verify.mjs", label: "CI push checks" }]));

const checks = (output: string | undefined, rules: readonly Rule[] = [TURN_CHECK!]): TurnChecks => ({
    rules,
    change: async () => ({ paths: ["intentic/a.ts"], repos: ["intentic"] }),
    run: async () => (output === undefined ? { status: "passed", output: "" } : { status: "failed", output }),
    onFired: () => undefined,
    logger: { warn: jest.fn() },
});

const request = (hooks: Partial<TurnHooks>, signal = new AbortController().signal): Pick<AgentRequest, "spec" | "signal" | "hooks"> => ({
    spec: { prompt: "fix it", cwd: "/w", sessionId: "s-0" },
    hooks: { cards, ...hooks },
    signal,
});

// A loop's run: the frames it streams, then what it is told after, recorded by the follow-up.
const ending = (editChecks: TurnEnding["editChecks"]) => {
    const told: { readonly note: string; readonly sessionId: string | undefined }[] = [];
    const turnEnding: TurnEnding = {
        editChecks,
        async *followUp(note, sessionId) {
            told.push({ note, sessionId });
            yield { kind: "delta", text: "fixed" };
        },
    };
    return { told, turnEnding };
};

async function* frames(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

const drain = async (turn: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const event of turn) {
        out.push(event);
    }
    return out;
};

const EDIT: AgentEvent = { kind: "tool_call", id: "t1", name: "Edit", category: "edit", status: "pending", locations: [{ path: "src/a.ts" }] };

test("a failing turn check rides one more prompt on the session the run reported, behind the checks' own notice", async () => {
    const { told, turnEnding } = ending("after-edit");
    const out = await drain(
        withEndingChecks(request({ turnChecks: checks("✗ a.ts: 1 finding") }), frames({ kind: "session", sessionId: "s-1" }, { kind: "delta", text: "done" }), turnEnding),
    );
    expect(out.map((event) => event.kind)).toEqual(["session", "delta", "agent_notice", "delta"]);
    expect(out[2]).toMatchObject({ source: TURN_CHECKS_SOURCE });
    expect(told).toHaveLength(1);
    expect(told[0]?.sessionId).toBe("s-1");
    expect(told[0]?.note).toContain("✗ a.ts: 1 finding");
});

test("a run that failed, or a turn that was stopped, ends without checks", async () => {
    const failed = ending("turn-end");
    await drain(withEndingChecks(request({ turnChecks: checks("✗") }), frames({ kind: "error", message: "boom" }), failed.turnEnding));
    expect(failed.told).toEqual([]);

    const stop = new AbortController();
    stop.abort();
    const stopped = ending("turn-end");
    await drain(withEndingChecks(request({ turnChecks: checks("✗") }, stop.signal), frames({ kind: "delta", text: "x" }), stopped.turnEnding));
    expect(stopped.told).toEqual([]);
});

test("checks that pass say nothing and send nothing", async () => {
    const { told, turnEnding } = ending("turn-end");
    const out = await drain(withEndingChecks(request({ turnChecks: checks(undefined) }), frames({ kind: "delta", text: "done" }), turnEnding));
    expect(out.map((event) => event.kind)).toEqual(["delta"]);
    expect(told).toEqual([]);
});

test("a loop with no hook after a call hears the edit checks on the files its edits touched, resolved where it ran", async () => {
    const seen: string[] = [];
    const reviewer: EditReviewer = async (file) => {
        seen.push(file);
        return `${file} has a stored secret in it`;
    };
    const { told, turnEnding } = ending("turn-end");
    const out = await drain(
        withEndingChecks(
            request({ editReviewers: [reviewer] }),
            frames(EDIT, { kind: "tool_call_update", id: "t1", status: "completed" }, { kind: "delta", text: "done" }),
            turnEnding,
        ),
    );
    expect(seen).toEqual(["/w/src/a.ts"]);
    expect(out.at(-2)).toMatchObject({ kind: "agent_notice", source: TURN_CHECKS_SOURCE });
    expect(told[0]?.note).toContain("/w/src/a.ts has a stored secret in it");
    expect(told[0]?.sessionId).toBe("s-0");
});

test("an edit that failed changed nothing, and a loop whose own hook said the edit checks is not told them twice", async () => {
    const reviewer = jest.fn<EditReviewer>(async () => "noted");
    const failedEdit = ending("turn-end");
    await drain(withEndingChecks(request({ editReviewers: [reviewer] }), frames(EDIT, { kind: "tool_call_update", id: "t1", status: "failed" }), failedEdit.turnEnding));
    const hooked = ending("after-edit");
    await drain(withEndingChecks(request({ editReviewers: [reviewer] }), frames(EDIT), hooked.turnEnding));
    expect(reviewer).not.toHaveBeenCalled();
    expect([...failedEdit.told, ...hooked.told]).toEqual([]);
});
