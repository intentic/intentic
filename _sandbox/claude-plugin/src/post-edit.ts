import { readOptions } from "./features.js";
import { dataDir, type Env, type HookInput, projectDir, runHook } from "./hook-io.js";
import { derivablePath, deriveNow } from "./shadows.js";

// PostToolUse on the file tools: a document Claude just wrote gets its shadow now rather than at the next sweep, so the
// next read of it is already derived. Everything else (source files, plain text) is left alone.

const PATH_KEYS = ["file_path", "notebook_path"] as const;

export const postEdit = (input: HookInput, env: Env = process.env): undefined => {
    if (!readOptions(env).shadows) {
        return undefined;
    }
    const project = projectDir(input, env);
    for (const key of PATH_KEYS) {
        const file = input.tool_input?.[key];
        const rel = typeof file === "string" ? derivablePath(project, file) : undefined;
        if (rel !== undefined) {
            deriveNow(dataDir(env), project, rel, env);
            return undefined;
        }
    }
    return undefined;
};

if (process.argv[1]?.endsWith("post-edit.mjs")) {
    await runHook((input) => postEdit(input));
}
