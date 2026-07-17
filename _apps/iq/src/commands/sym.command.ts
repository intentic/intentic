import { buildChoiceParser, buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type SymFlags = SearchFlags & { readonly kind?: "fn" | "method" | "class" | "type" | "const" | "route" | "test" };

export const sym = buildCommand({
    docs: { brief: "Fuzzy symbol-name search" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            kind: {
                kind: "parsed",
                parse: buildChoiceParser(["fn", "method", "class", "type", "const", "route", "test"] as const),
                optional: true,
                brief: "Narrow the symbol kind",
            },
        },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Name pattern (fuzzy or glob)", placeholder: "pattern" }] },
    },
    async func(this: CommandContext, flags: SymFlags, pattern: string) {
        await runSearch(this, "sym", pattern, flags, flags.kind !== undefined ? { symKind: flags.kind } : {});
    },
});
