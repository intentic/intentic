import { readFile } from "node:fs/promises";
import { renderVerify } from "@intentic/iq-engine";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { engineFromEnv, readStdin, resolveMode } from "../lib/run.js";

interface VerifyFlags {
    readonly json: boolean;
}

// `iq verify`: does an answer's every cited path, path:line anchor and code name exist here? Exit 0 when all hold,
// 1 when any does not, so a hook or CI step can gate on it.
export const verify = buildCommand({
    docs: { brief: "Check that an answer's file paths, path:line anchors and code names exist here; exit 1 on any that do not" },
    parameters: {
        flags: { json: { kind: "boolean", default: false, brief: "One JSON report" } },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, optional: true, brief: "The answer to check (markdown); - or nothing reads stdin", placeholder: "file" }],
        },
    },
    async func(this: CommandContext, flags: VerifyFlags, file?: string) {
        const fromStdin = file === undefined || file === "-";
        if (fromStdin && process.stdin.isTTY) {
            throw new Error("iq verify: pass the answer as a file (iq verify answer.md) or pipe it on stdin");
        }
        const text = fromStdin ? await readStdin() : await readFile(file, "utf8");
        const report = await engineFromEnv().verify(text);
        const source = fromStdin ? "stdin" : file;
        const mode = resolveMode({ json: flags.json, ndjson: false }, loadConfig().intenticOutput);
        this.process.stdout.write(mode === "text" ? renderVerify(report, source) : `${JSON.stringify({ source, ...report }, undefined, 4)}\n`);
        (this.process as { exitCode?: number | string | null }).exitCode = report.issues.length > 0 ? 1 : 0;
    },
});
