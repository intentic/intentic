import { WORKSPACE_ROOT } from "@intentic/constants";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { realYield } from "@intentic/testing/bun";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { createTurnGate } from "../../guard/turn-gate.js";
import { memoryFleet } from "../../testing.js";
import { answerPermission, type PermissionAsk, permissionAskOf, type SessionJudge } from "./opencode-permissions.js";

// Who answers OpenCode 2's permission asks: a registered session's ask goes through the same rulebook pipeline every
// other runtime uses, an unregistered one gets the standing yes. The judge behind the gate is a stub: the channel is
// under test, not the model. How an ask reaches this from the server's stream is the service's (opencode.test.ts).

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

type ReplyInput = Parameters<OpenCodeClient["permission"]["reply"]>[0];

// A shell ask as OpenCode 2.0.26 publishes it (shape recorded off a real server): the command line it would run is its
// one resource, and `save` is the rule an `always` would have filed.
const shellAsked = (id: string, sessionID: string, command: string): OpenCodeEvent => ({
    id: `evt_${id}`,
    created: 1_791_493_689_599,
    type: "permission.asked",
    location: { directory: WORKSPACE_ROOT },
    data: {
        id,
        sessionID,
        action: "shell",
        resources: [command],
        save: [`${command.split(" ").slice(0, 2).join(" ")} *`],
        source: { type: "tool", messageID: "msg_11d5850a20014MivT3Xm7tr4RD", id: "call_2" },
    },
});

const asked = (data: Partial<Extract<OpenCodeEvent, { type: "permission.asked" }>["data"]>): OpenCodeEvent => ({
    id: "evt_asked",
    created: 1_791_493_689_599,
    type: "permission.asked",
    data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: [], ...data },
});

const askOf = (event: OpenCodeEvent): PermissionAsk => {
    const ask = permissionAskOf(event);
    if (ask === undefined) {
        throw new Error(`no ask in ${event.type}`);
    }
    return ask;
};

// The server's side of an answer: every reply, as OpenCode received it.
const server = () => {
    const replies: ReplyInput[] = [];
    const client = unstubbed<OpenCodeClient>("client", {
        permission: unstubbed<OpenCodeClient["permission"]>("permission", {
            reply: async (input) => {
                replies.push(input);
            },
        }),
    });
    return { client, replies };
};

interface RecordedJudge {
    readonly judge: SessionJudge;
    readonly frames: AgentEvent[];
    readonly holds: string[];
    // The first frame the consult pushed: a card, once a hold has parked.
    readonly carded: Promise<AgentEvent>;
}

// What a turn registers for its sessions: the gate its rulebook built, a sink for the frames the card raises, and a hold
// on its watchdog, recorded here so a test can see the clock held for exactly the consult.
const judgeOf = (gate: CommandGuard): RecordedJudge => {
    const frames: AgentEvent[] = [];
    const holds: string[] = [];
    const carded = Promise.withResolvers<AgentEvent>();
    return {
        frames,
        holds,
        carded: carded.promise,
        judge: {
            gate,
            push: (frame) => {
                frames.push(frame);
                carded.resolve(frame);
            },
            hold: () => {
                holds.push("held");
                return () => void holds.push("released");
            },
        },
    };
};

// What capabilitiesOf("grok", …) declares: a hold parks on a card like Codex's.
const gates: (() => void)[] = [];
const approvalGate = (judge: () => Promise<{ decision: "allow" | "ask" | "refuse"; sentence: string }>): CommandGuard => {
    const { gate, release } = createTurnGate({ cards, judge, rulebook: "approval", signal: new AbortController().signal });
    gates.push(release);
    return gate;
};
afterEach(() => {
    for (const release of gates.splice(0)) {
        release();
    }
});

// A gate the call must not reach: any consult names itself and fails the test.
const unconsulted = (enforcing: boolean): CommandGuard => unstubbed<CommandGuard>("gate", { enforcing });

test("OpenCode 2's shell ask is read as its id, its session, its action and the command line it would run", () => {
    expect(permissionAskOf(shellAsked("per_11d5850fe001RJv7cMyKNP9WVc", "ses_ee2a7b0b7ffeRFM9FFPcb0yOv8", "git push origin main --dry-run"))).toEqual(
        {
            id: "per_11d5850fe001RJv7cMyKNP9WVc",
            sessionID: "ses_ee2a7b0b7ffeRFM9FFPcb0yOv8",
            kind: "shell",
            program: "git push origin main --dry-run",
        },
    );
});

test("a command the metadata names is read before the resources: the first non-blank of command, cmd, script and input", () => {
    const metadata = { command: "   ", cmd: 42, script: "make deploy", input: "make test" };
    expect(permissionAskOf(asked({ resources: ["make *"], metadata }))?.program).toBe("make deploy");
    expect(permissionAskOf(asked({ resources: ["make *"], metadata: { input: "make test" } }))?.program).toBe("make test");
});

test("an ask about several resources is read as all of them; one about none has no program", () => {
    expect(permissionAskOf(asked({ action: "edit", resources: ["src/a.ts", "src/b.ts"] }))).toEqual({
        id: "per_1",
        sessionID: "ses_1",
        kind: "edit",
        program: "src/a.ts src/b.ts",
    });
    expect(permissionAskOf(asked({ resources: [] }))?.program).toBeUndefined();
    expect(permissionAskOf(asked({ resources: [" "] }))?.program).toBeUndefined();
});

test("every other event raises no ask", () => {
    expect(permissionAskOf({ id: "evt_connected", type: "server.connected", data: {} })).toBeUndefined();
    expect(
        permissionAskOf({
            id: "evt_replied",
            created: 1_791_493_690_000,
            type: "permission.replied",
            data: { sessionID: "ses_1", requestID: "per_1", reply: "once" },
        }),
    ).toBeUndefined();
});

// A session whose turn has settled, or a delegation nobody registered, is where it always was: the standing yes. Never
// `always`, which OpenCode 2 files as a rule for the whole project that every later ask there would skip.
test("an unregistered session keeps the standing yes, for this call only", async () => {
    const { client, replies } = server();

    await answerPermission(client, undefined, askOf(shellAsked("per_4", "ses_unknown", "git push --force origin main")));

    expect(replies).toEqual([{ sessionID: "ses_unknown", requestID: "per_4", decision: "once" }]);
});

test("a gate that does not enforce, or an ask with nothing to judge, is answered yes without a consult or a hold", async () => {
    const { client, replies } = server();
    const lax = judgeOf(unconsulted(false));
    const strict = judgeOf(unconsulted(true));

    await answerPermission(client, lax.judge, askOf(shellAsked("per_5", "ses_lax", "git push --force origin main")));
    await answerPermission(client, strict.judge, askOf(asked({ id: "per_6", sessionID: "ses_strict", resources: [] })));

    expect(replies).toEqual([
        { sessionID: "ses_lax", requestID: "per_5", decision: "once" },
        { sessionID: "ses_strict", requestID: "per_6", decision: "once" },
    ]);
    expect(lax.holds).toEqual([]);
    expect(strict.holds).toEqual([]);
});

// The reason is what OpenCode hands the model as the call's failure; a reply with one keeps the session going.
test("a registered session's command is judged by the policy, and a refusal goes back with its reason", async () => {
    const { client, replies } = server();
    const { judge, holds, frames } = judgeOf(approvalGate(async () => ({ decision: "refuse", sentence: "Discards commits the remote has." })));

    await answerPermission(client, judge, askOf(shellAsked("per_2", "ses_gated", "git push --force origin main")));

    expect(replies).toEqual([
        {
            sessionID: "ses_gated",
            requestID: "per_2",
            decision: "reject",
            message: "Discards commits the remote has. Refused by your owner's safety policy. Do not retry.",
        },
    ]);
    expect(holds).toEqual(["held", "released"]);
    expect(frames).toEqual([]);
});

test("a command the policy allows is approved for this call only", async () => {
    const { client, replies } = server();
    const { judge, holds, frames } = judgeOf(approvalGate(async () => ({ decision: "allow", sentence: "Pushes a feature branch." })));

    await answerPermission(client, judge, askOf(shellAsked("per_3", "ses_ok", "git push origin feature")));

    expect(replies).toEqual([{ sessionID: "ses_ok", requestID: "per_3", decision: "once" }]);
    // The judge's own call is a wait on the daemon too, so the clock is held across it.
    expect(holds).toEqual(["held", "released"]);
    expect(frames).toEqual([]);
});

// The whole reason this runtime was refuse-only: a card waits on a person far past the two-minute silence limit. The
// turn's clock is held from the ask until the answer, the card reaches the turn's stream through its judge, and the
// person's answer goes back to OpenCode.
test("a hold parks on a card: the turn's clock is held until the person answers, and their yes lets the call run once", async () => {
    const { client, replies } = server();
    const { judge, frames, holds, carded } = judgeOf(
        approvalGate(async () => ({ decision: "ask", sentence: "Pushes straight to the shared main branch." })),
    );

    const answering = answerPermission(client, judge, askOf(shellAsked("per_7", "ses_card", "git push --force origin main")));
    const card = await carded;
    await realYield();

    // Parked: the card is out, the clock held, and OpenCode not yet answered.
    expect(frames).toMatchObject([
        { kind: "permission", toolName: "Bash", displayName: "Run command", program: { text: "git push --force origin main" } },
    ]);
    expect(holds).toEqual(["held"]);
    expect(replies).toEqual([]);

    if (card.kind !== "permission") {
        throw new Error(`a ${card.kind} frame came first, not the card`);
    }
    expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
    await answering;

    expect(frames.map((frame) => frame.kind)).toEqual(["permission", "resolved"]);
    expect(holds).toEqual(["held", "released"]);
    expect(replies).toEqual([{ sessionID: "ses_card", requestID: "per_7", decision: "once" }]);
});

// A person's no with words goes back as the model's feedback: the turn carries on told why, as a Claude turn's does.
test("a person's no goes back to OpenCode with their words", async () => {
    const { client, replies } = server();
    const { judge, holds, carded } = judgeOf(approvalGate(async () => ({ decision: "ask", sentence: "Pushes straight to the shared main branch." })));

    const answering = answerPermission(client, judge, askOf(shellAsked("per_8", "ses_no", "git push --force origin main")));
    const card = await carded;
    if (card.kind !== "permission") {
        throw new Error(`a ${card.kind} frame came first, not the card`);
    }
    expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "deny", feedback: "Open a pull request instead." })).toBe(
        "settled",
    );
    await answering;

    expect(replies).toEqual([{ sessionID: "ses_no", requestID: "per_8", decision: "reject", message: "Open a pull request instead." }]);
    expect(holds).toEqual(["held", "released"]);
});

// An ask left unanswered stalls the turn until its watchdog kills it; a consult with no verdict refuses instead.
test("a consult that fails is answered as a refusal rather than left unanswered", async () => {
    const { client, replies } = server();
    const broken = unstubbed<CommandGuard>("gate", {
        enforcing: true,
        // Fails before it has anything to say.
        consult: () => {
            throw new Error("the card store is gone");
        },
    });
    const { judge, holds } = judgeOf(broken);

    await answerPermission(client, judge, askOf(shellAsked("per_9", "ses_broken", "git push origin main")));

    expect(replies).toEqual([
        {
            sessionID: "ses_broken",
            requestID: "per_9",
            decision: "reject",
            message:
                "This could not be checked against your owner's safety policy, so it was refused. " +
                "Do not retry: carry on with what you can do without it, and say plainly what you left undone.",
        },
    ]);
    expect(holds).toEqual(["held", "released"]);
});
