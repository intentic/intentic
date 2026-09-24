import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { UTC, type Zone } from "@intentic/sandbox-contract";
import { KEYED_PARTS, nextPromptDayAt, promptDay, promptFingerprint } from "./prompt-fingerprint.js";

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

const init = (over: Partial<InitMessage> = {}): InitMessage =>
    ({
        type: "system",
        subtype: "init",
        claude_code_version: "3.1.0",
        model: "claude-opus-5-5",
        tools: ["Bash", "Read"],
        mcp_servers: [{ name: "ui", status: "connected" }],
        skills: ["iq"],
        plugins: [],
        output_style: "default",
        ...over,
    }) as InitMessage;

const NOON = new Date(Date.UTC(2026, 8, 24, 12));

describe("the prompt's fingerprint", () => {
    test("is the same for the same parts, and moves with the one that moved", () => {
        const options = { systemPrompt: "base", effort: "high" as const };
        const one = promptFingerprint(init(), options, NOON);
        expect(promptFingerprint(init(), options, NOON)).toEqual(one);
        const updated = promptFingerprint(init({ claude_code_version: "3.2.0" }), options, NOON);
        expect(updated.hash).not.toBe(one.hash);
        expect(Object.keys(one.parts).filter((part) => one.parts[part] !== updated.parts[part])).toEqual(["version"]);
    });

    test("keys the parts a refresh may stop on, and leaves out what `init` lists before servers connect", () => {
        expect(KEYED_PARTS).toContain("day");
        expect(KEYED_PARTS).not.toContain("tools");
        expect(KEYED_PARTS).not.toContain("mcp");
    });

    test("costs a missing field its part, never the turn", () => {
        const partial = { type: "system", subtype: "init", model: "m" } as unknown as InitMessage;
        expect(promptFingerprint(partial, {}, NOON).parts).toMatchObject({ model: "m", version: "", tools: expect.any(String) });
    });

    test("rolls with the date the CLI writes into its prompt, in the zone it runs in", () => {
        const warsaw = "Europe/Warsaw" as Zone;
        const late = Date.UTC(2026, 8, 24, 21, 30);
        expect(promptDay(new Date(late), UTC)).toBe("2026-09-24");
        expect(promptDay(new Date(late), warsaw)).toBe("2026-09-24");
        expect(nextPromptDayAt(late, UTC)).toBe(Date.UTC(2026, 8, 25));
        // Warsaw is on summer time in September, two hours ahead of UTC.
        expect(nextPromptDayAt(late, warsaw)).toBe(Date.UTC(2026, 8, 24, 22));
    });
});
