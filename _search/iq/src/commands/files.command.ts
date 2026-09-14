import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type FilesFlags = SearchFlags & { readonly exact: boolean };

/* The pattern is optional, the same shape `recent` has, and for a sharper reason than symmetry. */
export const files = buildCommand({
    docs: { brief: "Filename search, fuzzy by default, exact globbing with --exact; no pattern lists the tree" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            exact: { kind: "boolean", default: false, brief: "Treat the pattern as an exact glob, not fuzzy" },
        },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, optional: true, brief: "Fuzzy name or glob", placeholder: "pattern" }],
        },
    },
    async func(this: CommandContext, flags: FilesFlags, pattern?: string) {
        await runSearch(this, "files", pattern ?? "", flags, flags.exact ? { globExact: true } : {});
    },
});
