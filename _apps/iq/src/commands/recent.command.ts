import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type RecentFlags = SearchFlags & { readonly since?: string; readonly author?: string };

export const recent = buildCommand({
    docs: { brief: "Recently changed files (git + mtime), optionally filtered by a pattern" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            since: { kind: "parsed", parse: String, optional: true, brief: "Window like 2d, 12h, 1w (default 7d)" },
            author: { kind: "parsed", parse: String, optional: true, brief: "Filter by commit author" },
        },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, optional: true, brief: "Only files whose path matches", placeholder: "pattern" }],
        },
    },
    async func(this: CommandContext, flags: RecentFlags, pattern?: string) {
        await runSearch(this, "recent", pattern ?? "", flags, {
            ...(flags.since !== undefined ? { since: flags.since } : {}),
            ...(flags.author !== undefined ? { author: flags.author } : {}),
        });
    },
});
