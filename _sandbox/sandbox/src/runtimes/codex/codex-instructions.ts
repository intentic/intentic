import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRequest } from "../../agent/run/agent.js";
import type { JsonValue } from "./codex-app-server.js";

// The owner's standing instructions, as Codex takes them: two undocumented config keys sent in the per-thread config
// block, verified against codex-cli 0.147.
// - model_instructions_file replaces Codex's base prompt with the named file's contents (a path, why this module writes
//   to disk)
// - developer_instructions adds a message ahead of Codex's skills/team blocks, leaving the base prompt alone
// Content-addressed by sha256, so concurrent turns sharing one CODEX_HOME can't collide on the same prompt file.

// Where written prompts live inside the turn's CODEX_HOME; beside sessions, not in the workspace, since it's a
// rendering of a setting, not something the owner wrote.
const instructionsDir = (codexHome: string): string => join(codexHome, "instructions");

export const instructionsPath = (codexHome: string, text: string): string =>
    join(instructionsDir(codexHome), `${createHash("sha256").update(text).digest("hex")}.md`);

// This turn's config overrides for the instruction keys; empty when the turn asks for neither, leaving Codex untouched.
// An empty string prompt is still legal and sent like any other, distinct from asking for nothing.
export const codexInstructionConfig = async (
    request: Pick<AgentRequest, "systemPrompt" | "systemAppend">,
    codexHome: string,
): Promise<Record<string, JsonValue>> => {
    const config: Record<string, JsonValue> = {};
    if (request.systemPrompt !== undefined) {
        const path = instructionsPath(codexHome, request.systemPrompt);
        await mkdir(instructionsDir(codexHome), { recursive: true });
        await writeFile(path, request.systemPrompt);
        config["model_instructions_file"] = path;
    }
    if (request.systemAppend !== undefined) {
        config["developer_instructions"] = request.systemAppend;
    }
    return config;
};
