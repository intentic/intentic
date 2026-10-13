import type { TurnSpec } from "../../agent/providers/agent-request.js";
import { opt } from "../../opt.js";
import type { CodexInstructions, JsonValue } from "./codex-app-server.js";

// The owner's standing instructions, as Codex takes them: the two first-class fields of thread/start and thread/resume
// (codex-cli 0.162), sent with every turn, so a resumed thread takes the current wording rather than its first.
// - baseInstructions replaces Codex's base prompt, the role model_instructions_file used to play through a file on disk
// - developerInstructions adds a developer message ahead of Codex's skills, leaving the base prompt alone
// An empty prompt is still legal and sent like any other, distinct from asking for nothing.
export const codexInstructions = (spec: Pick<TurnSpec, "systemPrompt" | "systemAppend">): CodexInstructions => ({
    ...opt("base", spec.systemPrompt),
    ...opt("developer", spec.systemAppend),
});

// Codex reads the workspace's AGENTS.md on its own, and the daemon already composes it into the developer instructions
// above (system-prompt.ts), so a byte budget of zero keeps the model from reading the owner's rules twice. CODEX_HOME's
// own AGENTS.md is a different file and still loads.
export const PROJECT_DOC_CONFIG = { project_doc_max_bytes: 0 } as const satisfies Readonly<Record<string, JsonValue>>;
