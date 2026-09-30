import type { AgentRequest, TurnHooks } from "../../agent/providers/agent-request.js";
import { PROJECT_INSTALL_RULE } from "../../agent/providers/project-installs.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { consultWith, vendorSubject } from "../../guard/command-guard.js";
import { opt } from "../../opt.js";
import { conversationTainted } from "../../guard/turn-taint.js";
import { memoryFleet } from "../../testing.js";
import { vendorTurnGate } from "./vendor-gate.js";

/* The groups a vendor loop's gate is minted from: what it judges by (policy), who judges (hooks), where (spec). */

const SUBJECT = vendorSubject("bash");

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

const request = (
    over: { readonly policy?: AgentRequest["policy"]; readonly judge?: TurnHooks["judge"]; readonly projectInstalls?: TurnHooks["projectInstalls"] } = {},
    conversationId?: string,
): Pick<AgentRequest, "spec" | "policy" | "hooks" | "signal"> => ({
    spec: { prompt: "p", cwd: "/w", ...(conversationId === undefined ? {} : { conversationId }) },
    policy: over.policy ?? {},
    hooks: { cards, ...opt("judge", over.judge), ...opt("projectInstalls", over.projectInstalls) },
    signal: new AbortController().signal,
});

// The install rule a Claude Code turn's hook applies, carried to a vendor loop's gate by the same request field.
const installRule = (mode: "automatic" | "never"): NonNullable<TurnHooks["projectInstalls"]> => ({
    placement: { kind: "shared" },
    root: "/nonexistent-workspace",
    mode,
    canInstall: true,
    grants: undefined,
    rule: PROJECT_INSTALL_RULE,
});

test("a vendor turn's gate meets an install with the same rule as Claude Code's hook", async () => {
    const refused = vendorTurnGate(request({ projectInstalls: installRule("never") }));
    const events: AgentEvent[] = [];
    expect(await consultWith(refused.gate, "pnpm add zod", SUBJECT, (event) => events.push(event))).toMatchObject({
        allow: false,
        reason: expect.stringContaining("turned agent installs off"),
    });
    const allowed = vendorTurnGate(request({ projectInstalls: installRule("automatic") }));
    const outcome = await consultWith(allowed.gate, "pnpm add zod", SUBJECT, (event) => events.push(event), { cwd: "/nonexistent-workspace/video" });
    expect(outcome).toMatchObject({ allow: true, context: expect.stringContaining("install lane") });
    expect(events).toEqual([{ kind: "install", reach: "main-tree", projects: ["video"] }]);
    refused.release();
    allowed.release();
});

test("an outside wake in the policy is published under the spec's conversation until the gate is released", () => {
    const { release } = vendorTurnGate(request({ policy: { outsideWake: "discord" } }, "gate-c1"));
    expect(conversationTainted("gate-c1")).toBe(true);
    release();
    expect(conversationTainted("gate-c1")).toBe(false);
});

test("the policy's rulebook shapes the gate: a runtime with no seam is tainted for its whole life", () => {
    const { taint, release } = vendorTurnGate(request({ policy: { rulebook: "none" } }, "gate-c2"));
    expect(taint.tainted()).toBe(true);
    release();
});

test("the hooks' judge is the one asked, and a refuse-only runtime refuses what it would have held", async () => {
    const asked: string[] = [];
    const { gate, release } = vendorTurnGate(
        request({
            policy: { rulebook: "refuse-only" },
            judge: async (program) => {
                asked.push(program);
                return { decision: "ask", sentence: "Discards whatever commits origin has." };
            },
        }),
    );
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    release();

    expect(asked).toEqual(["git push --force origin main"]);
    expect(step.done).toBe(true);
    expect((step.value as { allow: boolean }).allow).toBe(false);
});

// Nobody watching is information for the judge, never a refusal: the card waits for the owner on a vendor turn too.
test("an unattended policy parks the ask on a card, and the judge is told nobody is watching", async () => {
    const seen: boolean[] = [];
    const { gate, release } = vendorTurnGate(
        request({
            policy: { unattended: true, rulebook: "approval" },
            judge: async (_program, facts) => {
                seen.push(facts.unattended);
                return { decision: "ask", sentence: "Discards whatever commits origin has." };
            },
        }),
    );
    const step = await gate.consult("git push --force origin main", SUBJECT).next();
    release();

    expect(step.done).toBe(false);
    expect(step.value).toMatchObject({ kind: "permission", title: "Discards whatever commits origin has." });
    expect(seen).toEqual([true]);
});
