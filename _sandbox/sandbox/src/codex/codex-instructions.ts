import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRequest } from "../agent/agent.js";
import type { JsonValue } from "./codex-app-server.js";

/* THE OWNER'S STANDING INSTRUCTIONS, AS CODEX TAKES THEM, the whole of what makes native Codex an
 * `instructions: "replace"` runtime rather than one that quietly drops the setting.
 *
 * Two config keys, both undocumented, both verified by reading what actually reached the wire (codex-cli
 * 0.147, a local server standing in for the model):
 *
 *   `model_instructions_file` REPLACES Codex's own base prompt, the "You are Codex, an agent based on GPT-5"
 *      developer message, with the contents of the file it names. It is a PATH and not a string, which is the
 *      only reason this module writes anything to disk.
 *   `developer_instructions` ADDS a developer message ahead of Codex's skills and team blocks, leaving its base
 *      where it is. That is the append.
 *
 * They ride the per-thread `config` block the adapter already sends to `thread/start`, so nothing here touches
 * the shared CODEX_HOME's config.toml, a turn's instructions are that turn's, and a user's own `codex exec`
 * from some other agent's shell is unaffected.
 *
 * CONTENT-ADDRESSED, which is what makes the file safe. Several turns plan concurrently against one CODEX_HOME;
 * a fixed filename would have them writing over each other's prompt between the write and the read, and the
 * loser would run on the winner's instructions. Naming the file after the sha256 of what is in it means two
 * turns with the same prompt write the same bytes to the same path and a turn with a different prompt cannot
 * collide at all. It also makes the write idempotent, so the steady state is one file per distinct prompt
 * rather than one per turn. */

// Where the written prompts live inside whichever CODEX_HOME served the turn. Beside the sessions rather than
// in the workspace: it is a rendering of a setting, not something the owner wrote in this tree.
const instructionsDir = (codexHome: string): string => join(codexHome, "instructions");

export const instructionsPath = (codexHome: string, text: string): string =>
    join(instructionsDir(codexHome), `${createHash("sha256").update(text).digest("hex")}.md`);

/* This turn's `config` overrides for the instruction keys, empty when the turn carries neither, which is the
 * ordinary case (no custom prompt, nothing to append) and must then leave Codex exactly as it was.
 *
 * An EMPTY replacement is written and sent like any other: "" is a legal custom prompt (the owner emptied the
 * box) and means no base prompt at all, which is a different turn from one that never asked. */
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
