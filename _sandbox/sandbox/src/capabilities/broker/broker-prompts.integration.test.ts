import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { createHeldCards } from "../../guard/held-cards.js";
import { revokeGrant, standingGrants } from "../../needs/standing-grants.js";
import { standingDeps } from "../../needs/standing-grants.testing.js";
import { type ConversationGrants, fileConversationGrants } from "../../personas/conversation-grants.js";
import { createCredentialGrants } from "../../secrets/credential-grants.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createRulePrompts } from "./broker-prompts.js";
import type { RuleAsk } from "./broker-gateway.js";

// The credential gateway's `ask` card over a real parked-card registry and a real grants file. A pass is a person's yes
// like any other: kept on disk, read again after a restart, listed where it can be taken back, and gone when it is. Its
// card waits for an answer however long that takes, and outlives a request that gave up waiting.

const cards = parkedCards(memoryFleet().conversations);

const grantsFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "broker-prompts-")), "conversation-grants.json");

const RULE = '{"action":"ask","method":"POST","path":"/repos/*/issues"}';

const asked = (over: Partial<RuleAsk> = {}): RuleAsk => ({
    capability: "github",
    name: "GitHub",
    rule: RULE,
    why: undefined,
    method: "POST",
    target: "api.github.com/repos/acme/app/issues",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

const prompts = (grants: ConversationGrants) => {
    const frames: AgentEvent[] = [];
    const woken: string[] = [];
    let turn = Promise.withResolvers<void>();
    const held = createHeldCards(async (_conversationId, prompt) => void woken.push(prompt));
    const made = createRulePrompts({
        cards,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "conv-1", push: (event) => frames.push(event) }),
        observe: () => {},
        awaiting: () => {},
        grants,
        hold: { held, finished: () => turn.promise },
        warn: () => {},
    });
    const endTurn = (): void => {
        turn.resolve();
        turn = Promise.withResolvers<void>();
    };
    return { prompts: made, frames, woken, held, endTurn };
};

const answer = async (frames: AgentEvent[], decision: "once" | "always" | "deny", from = 0): Promise<void> => {
    let raised: AgentEvent | undefined;
    for (let waited = 0; raised === undefined && waited < 2000; waited += 1) {
        raised = frames.slice(from).find((frame) => frame.kind === "permission");
        if (raised === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 1));
        }
    }
    if (raised?.kind !== "permission") {
        throw new Error("no permission card was raised");
    }
    expect(cards.resolve({ kind: "permission", requestId: raised.requestId, decision })).toBe("settled");
};

// The mirror the gateway reads is filled from the file as the prompts are made, and again when a grant changes.
const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 20; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

test("an 'allow requests like this' survives a restart, is listed, and taken back on the Allowed list", async () => {
    const path = await grantsFile();
    const first = prompts(fileConversationGrants(path));
    const pending = first.prompts.ask(asked());
    await answer(first.frames, "always");
    expect(await pending).toEqual({ allow: true });
    expect(first.prompts.passed("conv-1", "github", RULE)).toBe(true);

    // A fresh store and fresh prompts over the same file are how a restart reads it.
    const grants = fileConversationGrants(path);
    const second = prompts(grants);
    await settle();
    expect(second.prompts.passed("conv-1", "github", RULE)).toBe(true);
    expect(second.prompts.passed("conv-2", "github", RULE)).toBe(false);
    expect(second.prompts.passed("conv-1", "linear", RULE)).toBe(false);

    const deps = standingDeps({ conversationGrants: grants, credentialGrants: createCredentialGrants() });
    expect((await standingGrants(deps)).conversations[0]?.rules).toEqual([
        { capability: "github", rule: RULE, said: "POST api.github.com/repos/acme/app/issues with GitHub" },
    ]);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "rule", what: RULE, capability: "github" })).toBe(true);
    await settle();
    expect(second.prompts.passed("conv-1", "github", RULE)).toBe(false);
});

test("an allow-once leaves no pass behind", async () => {
    const grants = fileConversationGrants(await grantsFile());
    const { prompts: made, frames } = prompts(grants);
    const pending = made.ask(asked());
    await answer(frames, "once");
    expect(await pending).toEqual({ allow: true });
    expect(made.passed("conv-1", "github", RULE)).toBe(false);
    expect((await grants.of("conv-1"))?.rules ?? []).toEqual([]);
});

test("a card waits past a request that gave up; a late yes wakes the conversation and the same request goes once", async () => {
    const { prompts: made, frames, held, woken, endTurn } = prompts(fileConversationGrants(await grantsFile()));
    const gone = new AbortController();
    const first = made.ask(asked({ signal: gone.signal }));
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    gone.abort();
    expect(await first).toEqual({ allow: false, reason: expect.stringContaining("Still waiting for a person to answer the card") });

    const closing = held.hold("conv-1", undefined);
    await answer(frames, "once");
    await closing;
    endTurn();
    expect(woken).toHaveLength(1);
    expect(woken[0]).toContain("The owner allowed sending POST api.github.com/repos/acme/app/issues with GitHub after your turn ended.");

    expect(await made.ask(asked())).toEqual({ allow: true });
    expect(frames.filter((frame) => frame.kind === "permission")).toHaveLength(1);
});

test("a card nobody answered refuses only when the turn ends", async () => {
    const { prompts: made, frames, endTurn } = prompts(fileConversationGrants(await grantsFile()));
    const pending = made.ask(asked());
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    endTurn();
    expect(await pending).toEqual({ allow: false, reason: expect.stringContaining("The turn ended before anyone answered") });
});
