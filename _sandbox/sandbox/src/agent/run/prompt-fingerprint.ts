import { createHash } from "node:crypto";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { civilDayIn, localZone, nextDayStartIn, type PromptFingerprint, type Zone } from "@intentic/sandbox-contract";

// Only what the CLI announces at `init` and what the turn hands it; the request itself is never seen here.

type InitMessage = Extract<SDKMessage, { type: "system"; subtype: "init" }>;

const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

// The CLI child inherits this process's zone and writes its prompt's date in it, whatever zone anybody reading is in.
const cliZone = (): Zone => localZone();

export const promptDay = (now: Date = new Date(), zone: Zone = cliZone()): string => civilDayIn(now.getTime(), zone);

// When `promptDay` next changes.
export const nextPromptDayAt = (now: number = Date.now(), zone: Zone = cliZone()): number => nextDayStartIn(now, zone);

// Tools and servers are left out: `init` lists them before slow servers connect, so only the cache's numbers can judge them.
export const KEYED_PARTS: readonly string[] = ["version", "model", "system", "reasoning", "skills", "agents", "plugins", "style", "day"];

// Read as partial: a CLI that stops announcing one field must cost the fingerprint that part, never the turn.
export const promptFingerprint = (message: InitMessage, options: Pick<Options, "systemPrompt" | "effort" | "thinking">, now: Date = new Date()): PromptFingerprint => {
    const init: Partial<InitMessage> = message;
    const parts: Record<string, string> = {
        version: init.claude_code_version ?? "",
        model: init.model ?? "",
        system: short(JSON.stringify(options.systemPrompt ?? "")),
        reasoning: `${options.effort ?? "-"}/${options.thinking?.type ?? "-"}`,
        tools: short((init.tools ?? []).join("\n")),
        mcp: short((init.mcp_servers ?? []).map((server) => server.name).join("\n")),
        skills: short((init.skills ?? []).join("\n")),
        agents: short((init.agents ?? []).join("\n")),
        plugins: short((init.plugins ?? []).map((plugin) => `${plugin.name}@${plugin.version ?? ""}`).join("\n")),
        style: init.output_style ?? "",
        betas: short((init.betas ?? []).join("\n")),
        day: promptDay(now),
    };
    return { hash: short(JSON.stringify(parts)), parts };
};
