/* `fileq derive <file…>`: converge sidecars for named files, one outcome line each. This is the daemon's
 * verb — the eager service hands it every watcher batch that touched a candidate file, and a path that
 * VANISHED is as much its business as one that landed: derive on a missing source removes the orphaned
 * shadow, so deletion cleanup rides the same call as creation. */
import { resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { ensureSidecar, type Outcome } from "../lib/derive.js";
import { workspaceRoot } from "../lib/env.js";

interface DeriveFlags {
    readonly json: boolean;
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
        },
        positional: { kind: "array", parameters: { parse: String, brief: "Files to converge, workspace-root-relative (the watcher's own namespace) or absolute", placeholder: "file" } },
    },
    async func(this: CommandContext, flags: DeriveFlags, ...files: string[]) {
        const root = workspaceRoot();
        if (root === undefined) {
            this.process.stdout.write("fileq: derive needs a workspace (WORKSPACE_ROOT is not set); use `fileq read` for one-off files\n");
            process.exitCode = 2;
            return;
        }
        if (files.length === 0) {
            this.process.stdout.write("fileq: derive takes file paths (or run `fileq sweep` for the whole workspace)\n");
            process.exitCode = 2;
            return;
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
