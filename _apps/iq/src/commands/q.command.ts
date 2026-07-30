import { buildChoiceParser, buildCommand, type CommandContext } from "@stricli/core";
import type { Verb } from "@intentic/iq-engine";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

const MODES = ["find", "files", "def", "refs", "sym", "ast"] as const;

type QFlags = SearchFlags & { readonly mode?: (typeof MODES)[number] };

// The default route: bare `iq "query"` lands here, classifies the query, and fuses engines. --mode pins one
// engine for flat-flag harnesses.
export const q = buildCommand({
    docs: { brief: "Auto mode (default) — classify the query and fuse engines" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            mode: { kind: "parsed", parse: buildChoiceParser(MODES), optional: true, brief: "Pin one search verb instead of auto" },
        },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "Query: identifier, regex, path, or natural language", placeholder: "query" }],
        },
    },
    async func(this: CommandContext, flags: QFlags, query: string) {
        const verb: Verb = flags.mode ?? "q";
        await runSearch(this, verb, query, flags, flags.mode !== undefined ? { mode: flags.mode } : {});
    },
});
