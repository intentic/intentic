/* `fileq derive` derives metadata from one input file. */
import { resolve } from "node:path";
import { countParser } from "@intentic/agent-cli/flags";
import { buildCommand, type CommandContext } from "@stricli/core";
import { ensureSidecar, type Outcome } from "../lib/derive.js";
import { workspaceRoot } from "../lib/env.js";

interface DeriveFlags {
    readonly json: boolean;
    readonly ocrPages?: number;
}

export const outcomeLine = (outcome: Outcome): string => {
    switch (outcome.kind) {
        case "derived":
            return `derived ${outcome.relPath} -> ${outcome.sidecarPath} (${outcome.tokens} tokens)`;
        case "fresh":
            return `fresh ${outcome.relPath}`;
        case "removed":
            return `removed ${outcome.relPath} (source gone)`;
        case "skipped":
            return `skipped ${outcome.relPath}: ${outcome.reason}`;
    }
};

export const deriveCommand = buildCommand({
    docs: { brief: "Converge sidecars for the named files (derive stale, remove orphaned, skip fresh)" },
    parameters: {
        flags: {
            json: { kind: "boolean", default: false, brief: "One JSON object per line" },
            ocrPages: {
                kind: "parsed",
                parse: countParser,
                optional: true,
                brief: "Recognise up to this many pages of a scanned pdf (default 20; the daemon's background keeper asks for more)",
            },
        },
        positional: { kind: "array", parameter: { parse: String, brief: "Files to converge, workspace-root-relative (the watcher's own namespace) or absolute", placeholder: "file" } },
    },
    async func(this: CommandContext, flags: DeriveFlags, ...files: string[]) {
        const root = workspaceRoot();
        if (root === undefined) {
            this.process.stdout.write("fileq: derive needs a workspace (WORKSPACE_ROOT is not set); use `fileq read` for one-off files\n");
            process.exitCode = 2;
            return;
        }
        if (files.length === 0) {
            this.process.stdout.write("fileq: derive takes file paths\n");
            process.exitCode = 2;
            return;
        }
        // The pdf reader reads its cap from the environment, so the flag reaches it however deep the call chain.
        if (flags.ocrPages !== undefined) {
            process.env["FILEQ_OCR_PAGES"] = String(flags.ocrPages);
        }
        let useful = 0;
        for (const file of files) {
            const outcome = await ensureSidecar(root, resolve(root, file));
            if (outcome.kind !== "skipped") {
                useful += 1;
            }
            if (flags.json) {
                this.process.stdout.write(`${JSON.stringify(outcome.kind === "derived" ? { ...outcome, doc: undefined, body: undefined } : outcome)}\n`);
            } else {
                this.process.stdout.write(`${outcomeLine(outcome)}\n`);
            }
        }
        // grep's convention: 0 something derivable was converged, 1 nothing here was fileq's business.
        process.exitCode = useful > 0 ? 0 : 1;
    },
});
