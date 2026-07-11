import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type LogFlags = SearchFlags & { readonly since?: string; readonly author?: string; readonly path?: string; readonly regex: boolean };

export const log = buildCommand({
    docs: { brief: "Search git history for a string (pickaxe) across workspace repos" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            since: { kind: "parsed", parse: String, optional: true, brief: "Window like 2d, 1w, 3m" },
            author: { kind: "parsed", parse: String, optional: true, brief: "Filter by commit author" },
            path: { kind: "parsed", parse: String, optional: true, brief: "Restrict history to a path" },
            regex: { kind: "boolean", default: false, brief: "Pickaxe as regex (-G) instead of literal (-S)" },
        },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "String whose additions/removals to find", placeholder: "pattern" }] },
    },
    async func(this: CommandContext, flags: LogFlags, pattern: string) {
        await runSearch(this, "log", pattern, flags, {
            ...(flags.since !== undefined ? { since: flags.since } : {}),
            ...(flags.author !== undefined ? { author: flags.author } : {}),
            ...(flags.path !== undefined ? { path: flags.path } : {}),
            ...(flags.regex ? { logRegex: true } : {}),
        });
    },
});
