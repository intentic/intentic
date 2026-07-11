import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type FindFlags = SearchFlags & { readonly literal: boolean; readonly word: boolean; readonly case: boolean };

export const find = buildCommand({
    docs: { brief: "Lexical content search — regex by default, smart-case" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            literal: { kind: "boolean", default: false, brief: "Fixed-string match instead of regex" },
            word: { kind: "boolean", default: false, brief: "Word-boundary match" },
            case: { kind: "boolean", default: false, brief: "Case-sensitive (default: smart-case)" },
        },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Regex (or literal with --literal)", placeholder: "pattern" }] },
    },
    async func(this: CommandContext, flags: FindFlags, pattern: string) {
        await runSearch(this, "find", pattern, flags, {
            ...(flags.literal ? { literal: true } : {}),
            ...(flags.word ? { word: true } : {}),
            ...(flags.case ? { caseSensitive: true } : {}),
        });
    },
});
