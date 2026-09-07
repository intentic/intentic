import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type FilesFlags = SearchFlags & { readonly exact: boolean };

/* The pattern is optional, the same shape `recent` has, and for a sharper reason than symmetry. Required, it
 * exited 2 with a one-line usage error on STDERR — and 95% of transcript calls redirect stderr, so
 * `iq files 2>/dev/null | grep -i fleet` came back completely empty and the agent read that as "no such file
 * exists" and reasoned on from a false negative. Five of those in a fortnight. A verb whose zero-argument
 * meaning is obvious ("which files are there") must not have a failure mode that looks like an answer. */
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
