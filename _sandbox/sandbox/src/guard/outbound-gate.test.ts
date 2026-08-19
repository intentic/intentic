import type { SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { outboundGateHooks } from "./outbound-gate.js";

const DISCORD_SEND = `curl -s -X POST "https://discord.com/api/v10/channels/123/messages" -H "Authorization: Bot $TOKEN" -d '{"content":"hi"}'`;

// Drive the PreToolUse hook the way the SDK does: one Bash call, the command in tool_input.
const run = async (rules: Parameters<typeof outboundGateHooks>[0], command: unknown): Promise<SyncHookJSONOutput> => {
    const matcher = outboundGateHooks(rules).PreToolUse?.[0];
    const hook = matcher?.hooks[0];
    if (hook === undefined) {
        throw new Error("gate wired no PreToolUse hook");
    }
    // The gate only ever answers synchronously — it decides from the command string alone, so it never returns
    // the SDK's `{ async: true }` deferral.
    return hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } } as Parameters<typeof hook>[0], undefined, {
        signal: new AbortController().signal,
    }) as Promise<SyncHookJSONOutput>;
};

describe("outbound gate", () => {
    test("an unclassified command passes untouched", async () => {
        expect(await run({ "discord.message.send": "deny" }, "ls -la")).toEqual({});
    });

    test("a non-string command passes untouched (nothing to classify)", async () => {
        expect(await run({ "discord.message.send": "deny" }, undefined)).toEqual({});
    });

    test("an allowed classified call passes untouched", async () => {
        expect(await run({ "slack.message.send": "deny" }, DISCORD_SEND)).toEqual({});
    });

    test("a denied call is refused before it runs, with the rule's sentence", async () => {
        const out = await run({ "discord.message.send": "deny" }, DISCORD_SEND);
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect((out.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason).toContain("discord message.send");
    });

    test("a held call is refused toward the drafts outbox — the held form of a send", async () => {
        const out = await run({ "discord.*": "hold" }, DISCORD_SEND);
        expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        expect((out.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason).toContain(".intentic/config/drafts/");
    });
});
