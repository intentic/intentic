import type { AgentEvent } from "@intentic/sandbox-contract";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { createHeldCards } from "../../guard/held-cards.js";
import { memoryFleet } from "../../testing.js";
import { createProgramGuardGate, type ProgramGuardGateDeps, type ProgramWidenRequest } from "./program-guard-gate.js";

// Widening a secret's program guard over a real parked-card registry: a card in the live conversation that only the
// owner's click answers, worded by what the change adds, and refused outright with nobody to ask.

const cards = parkedCards(memoryFleet().conversations);

const OWNER = { email: "owner@corp.com", role: "owner" } as const;
const EVE = { email: "eve@corp.com", role: "maintainer" } as const;

const fake = (over: Partial<ProgramGuardGateDeps> = {}) => {
    const frames: AgentEvent[] = [];
    const turn = Promise.withResolvers<void>();
    const deps: ProgramGuardGateDeps = {
        cards,
        hold: { held: createHeldCards(async () => {}), finished: () => turn.promise },
        ownerEmail: async () => OWNER.email,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        awaiting: () => {},
        ...over,
    };
    return { deps, frames };
};

const request = (over: Partial<ProgramWidenRequest> = {}): ProgramWidenRequest => ({
    subject: "RDP_PASSWORD",
    from: { programs: ["mstsc.exe"], packages: [], anyField: false },
    to: { programs: ["mstsc.exe", "putty.exe"], packages: ["com.microsoft.rdc.androidx"], anyField: false },
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

// Answers the first permission card at or after `from`, as `caller`.
const answer = async (frames: AgentEvent[], decision: "once" | "deny", caller: typeof OWNER | typeof EVE) => {
    let raised: AgentEvent | undefined;
    for (let waited = 0; raised === undefined && waited < 2000; waited += 1) {
        raised = frames.find((frame) => frame.kind === "permission");
        if (raised === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    }
    if (raised?.kind !== "permission") {
        throw new Error("no permission card was raised");
    }
    return cards.resolve({ kind: "permission", requestId: raised.requestId, decision }, caller);
};

test("asks the owner on a card naming what the change adds, and only the owner's click counts", async () => {
    const { deps, frames } = fake();
    const pending = createProgramGuardGate(deps).widen(request());
    expect(await answer(frames, "once", EVE)).toEqual({ refused: `Only the owner (${OWNER.email}) can loosen a secret's program guard.` });
    await answer(frames, "once", OWNER);
    expect(await pending).toEqual({ approvedBy: OWNER.email });
    expect(frames[0]).toEqual({
        kind: "permission",
        requestId: expect.any(String),
        toolName: "secrets.programs",
        title: "Let the agent type RDP_PASSWORD into putty.exe and the com.microsoft.rdc.androidx app without asking?",
        displayName: "Loosen program guard",
        explain: "RDP_PASSWORD is typed unasked only into mstsc.exe now. Typing it anywhere else asks the person at that computer first, every time.",
        reason: "only the owner can loosen a secret's program guard",
        alwaysAsks: true,
    });
});

test("words letting it into any field, and reports a decline", async () => {
    const { deps, frames } = fake();
    const pending = createProgramGuardGate(deps).widen(request({ to: { programs: ["mstsc.exe"], packages: [], anyField: true } }));
    await answer(frames, "deny", OWNER);
    expect(await pending).toEqual({ refusal: "The owner kept RDP_PASSWORD's program guard as it is: nothing changed. Do not ask again for the same change." });
    expect(frames[0]).toMatchObject({ title: "Let the agent type RDP_PASSWORD into fields not marked as password fields without asking?" });
});

test("refuses a widening without a card when there is no live conversation to ask in", async () => {
    const { deps, frames } = fake({ liveRun: () => undefined });
    expect(await createProgramGuardGate(deps).widen(request())).toEqual({ refusal: expect.stringContaining("there is no live conversation to ask in") });
    expect(frames).toEqual([]);
});
