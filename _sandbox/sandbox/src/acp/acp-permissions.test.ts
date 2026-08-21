import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { createCommandGate } from "../guard/command-gate.js";
import { createTurnTaint, NO_TAINT } from "../guard/turn-taint.js";
import { decidePermission } from "./acp-permissions.js";

const request = (
    kind: string | undefined,
    options: { optionId: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[],
    toolCall: Partial<RequestPermissionRequest["toolCall"]> = {},
): RequestPermissionRequest => ({
    sessionId: "s1",
    toolCall: { toolCallId: "t1", ...(kind !== undefined ? { kind: kind as "edit" } : {}), ...toolCall },
    options: options.map((option) => ({ ...option, name: option.optionId })),
});

test("execute phase auto-allows, preferring allow_always", async () => {
    const decided = await decidePermission(
        request("execute", [
            { optionId: "once", kind: "allow_once" },
            { optionId: "always", kind: "allow_always" },
        ]),
        "execute",
        false,
    );
    expect(decided).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
});

test("plan phase rejects mutating tool kinds but allows reads", async () => {
    const options: Parameters<typeof request>[1] = [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
    ];
    expect(await decidePermission(request("edit", options), "plan", false)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(await decidePermission(request("read", options), "plan", false)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("plan phase with no rejection offered falls through to allow (best-effort read-only)", async () => {
    expect(await decidePermission(request("execute", [{ optionId: "allow", kind: "allow_once" }]), "plan", false)).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
    });
});

test("an aborted turn answers cancelled; no options at all answers cancelled", async () => {
    expect(await decidePermission(request("execute", [{ optionId: "allow", kind: "allow_once" }]), "execute", true)).toEqual({
        outcome: { outcome: "cancelled" },
    });
    expect(await decidePermission(request("execute", []), "execute", false)).toEqual({ outcome: { outcome: "cancelled" } });
});

/* THE OWNER'S RULEBOOK, over the one seam ACP publishes. What is being checked is that a Codex/Grok/ACP turn
 * now reaches the SAME decide fn a Claude turn does: the classifier, the rules, and the taint floor, none of
 * which an ACP agent could see before. */
const OPTIONS: Parameters<typeof request>[1] = [
    { optionId: "yes", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
];

const gateWith = (
    rules: Parameters<typeof createCommandGate>[0]["rules"],
    extras: Partial<Parameters<typeof createCommandGate>[0]> = {},
): ReturnType<typeof createCommandGate> =>
    createCommandGate({ rules, unattended: true, signal: new AbortController().signal, taint: NO_TAINT, ...extras });

test("a denied class is rejected, read out of the tool call's own rawInput", async () => {
    const gate = gateWith({ "git.destructive": "deny" });
    const call = request("execute", OPTIONS, { rawInput: { command: "git push --force origin main" } });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
});

test("an unclassified command is allowed, so an ordinary turn is untouched", async () => {
    const gate = gateWith({ "git.destructive": "deny" });
    const call = request("execute", OPTIONS, { rawInput: { command: "pnpm test" } });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

// The rulebook is the OWNER'S, not a per-tool prompt: with no rules and no taint, the standing auto-allow holds
// and the gate is never consulted at all. This is what keeps an unconfigured workspace behaving as it always did.
test("a workspace with no rules is not gated", async () => {
    const gate = gateWith({});
    expect(gate.enforcing).toBe(false);
    const call = request("execute", OPTIONS, { rawInput: { command: "git push --force origin main" } });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

// An agent that offers no way to say no cannot be refused, which is the limit `rulebook: "approval"` discloses.
test("with no rejection option offered, the call is allowed rather than cancelling the turn", async () => {
    const gate = gateWith({ "git.destructive": "deny" });
    const call = request("execute", [{ optionId: "yes", kind: "allow_once" }], { rawInput: { command: "git push --force origin main" } });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
});

/* The taint floor reaches ACP too: a turn woken by a stranger does not get to read credential material. Here
 * the turn is unattended, so the floor's HOLD is delivered as the refusal (nobody could answer a card). */
test("the taint floor holds a credential read on a turn a stranger woke", async () => {
    const gate = gateWith({}, { taint: createTurnTaint("discord") });
    expect(gate.enforcing).toBe(true);
    const call = request("execute", OPTIONS, { rawInput: { command: "cat .env" } });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
});

/* `title` is the last resort when an agent's rawInput carries no command field. Worth a test because it is the
 * difference between classifying most agents and classifying only the ones that happen to name a field the way
 * Claude Code does. */
test("a command in the call's title is classified when rawInput carries none", async () => {
    const gate = gateWith({ "files.destructive": "deny" });
    const call = request("execute", OPTIONS, { title: 'Run "rm -rf /work/intentic"' });
    expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
});

test("a hostile rawInput shape is survived rather than thrown on", async () => {
    const gate = gateWith({ "git.destructive": "deny" });
    for (const rawInput of [null, 42, "a string", [], { command: 7 }, { command: "" }]) {
        const call = request("execute", OPTIONS, { rawInput });
        expect(await decidePermission(call, "execute", false, gate)).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    }
});

/* An ATTENDED turn parks on a card, exactly as the Claude path does, and the agent waits on the JSON-RPC
 * request meanwhile. This is the behaviour that was impossible before: a hold on a non-Claude runtime had
 * nowhere to be raised. */
test("a held class raises a permission card and the call runs when the user allows it", async () => {
    const events: { kind: string; requestId?: string }[] = [];
    const gate = createCommandGate({
        rules: { "git.destructive": "hold" },
        unattended: false,
        signal: new AbortController().signal,
        taint: NO_TAINT,
    });
    const call = request("execute", OPTIONS, { rawInput: { command: "git push --force origin main" } });
    const pending = decidePermission(call, "execute", false, gate, (event) => events.push(event as { kind: string; requestId?: string }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const card = events.find((event) => event.kind === "permission");
    expect(card).toBeDefined();
    expect(resolveRequest({ kind: "permission", requestId: card?.requestId ?? "", decision: "once" })).toBe(true);
    expect(await pending).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    // The card owes the stream its resolution frame, on this transport exactly as on the Claude one.
    expect(events.some((event) => event.kind === "resolved")).toBe(true);
});
