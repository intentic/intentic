import { spawnSync } from "node:child_process";
import { readOptions } from "./features.js";
import { type Env, type HookAnswer, type HookInput, projectDir, runHook } from "./hook-io.js";
import { onPath } from "./runtime.js";

// UserPromptSubmit: iq's session recall (a prompt that matches past work is pointed at the session that did it, the same
// matcher the standalone iq plugin runs).

// Under the hook's own 10s ceiling, so a slow matcher costs its suggestion and never the prompt.
const MATCH_TIMEOUT_MS = 8_000;

export const promptSubmit = (input: HookInput, raw: string, env: Env = process.env): HookAnswer => {
    if (!readOptions(env).iq || !onPath("iq", env)) {
        return undefined;
    }
    const match = spawnSync("iq", ["sessions", "match", "--hook"], { cwd: projectDir(input, env), input: raw, encoding: "utf8", timeout: MATCH_TIMEOUT_MS, env: { ...env } });
    return match.status === 0 && typeof match.stdout === "string" && match.stdout.trim() !== "" ? match.stdout : undefined;
};

if (process.argv[1]?.endsWith("prompt-submit.mjs")) {
    await runHook((input, raw) => promptSubmit(input, raw));
}
