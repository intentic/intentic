/* `fileq sweep`: the whole workspace converged in one pass — every derivable file shadowed, every orphaned
 * shadow pruned. What the daemon runs when the sidecars setting turns on and after mass changes; also the
 * honest way to bootstrap a workspace that predates the feature. Prints a per-outcome line as it goes (a
 * sweep can take minutes on a document-heavy tree, and a silent minute reads as a hang), then the totals. */
import { buildCommand, type CommandContext } from "@stricli/core";
import { sweep } from "../lib/sweep.js";
import { workspaceRoot } from "../lib/env.js";
import { outcomeLine } from "./derive.command.js";

interface SweepFlags {
    readonly json: boolean;
    readonly quiet: boolean;
}

export const sweepCommand = buildCommand({
    docs: { brief: "Converge every derivable workspace file's sidecar; prune shadows of deleted files" },
    parameters: {
        flags: {
            json: { kind: "boolean", default: false, brief: "Machine-readable summary on stdout" },
            quiet: { kind: "boolean", default: false, brief: "Totals only, no per-file lines" },
        },
        positional: { kind: "tuple", parameters: [] },
    },
    async func(this: CommandContext, flags: SweepFlags) {
        const root = workspaceRoot();
        if (root === undefined) {
            this.process.stdout.write("fileq: sweep needs a workspace (WORKSPACE_ROOT is not set)\n");
            process.exitCode = 2;
            return;
        }
        const result = await sweep(root, (outcome) => {
            if (!flags.quiet && !flags.json && outcome.kind !== "fresh") {
                this.process.stdout.write(`${outcomeLine(outcome)}\n`);
            }
        });
        const counts = { derived: 0, fresh: 0, removed: 0, skipped: 0 };
        for (const outcome of result.outcomes) {
            counts[outcome.kind] += 1;
        }
        if (flags.json) {
            this.process.stdout.write(`${JSON.stringify({ ...counts, pruned: result.pruned.length })}\n`);
        } else {
            for (const relPath of result.pruned) {
                this.process.stdout.write(`pruned ${relPath} (source gone)\n`);
            }
            this.process.stdout.write(
                `sweep: ${counts.derived} derived, ${counts.fresh} fresh, ${counts.removed + result.pruned.length} removed, ${counts.skipped} skipped\n`,
            );
        }
    },
});
