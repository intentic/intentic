import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type HotspotsFlags = SearchFlags & { readonly since?: string; readonly author?: string };

export const hotspots = buildCommand({
    docs: { brief: "Files that are both changed often and structurally complex, where risk concentrates" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            since: { kind: "parsed", parse: String, optional: true, brief: "Only count commits within 2d, 12h, 1w (default: all history)" },
            author: { kind: "parsed", parse: String, optional: true, brief: "Only count commits by this author" },
        },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, optional: true, brief: "Only files whose path matches", placeholder: "pattern" }],
        },
    },
    async func(this: CommandContext, flags: HotspotsFlags, pattern?: string) {
        await runSearch(this, "hotspots", pattern ?? "", flags, {
            ...(flags.since !== undefined ? { since: flags.since } : {}),
            ...(flags.author !== undefined ? { author: flags.author } : {}),
        });
    },
});
