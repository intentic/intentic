import { buildChoiceParser, buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

type RefsFlags = SearchFlags & { readonly kind?: "call" | "import" | "type" | "write" };

export const refs = buildCommand({
    docs: { brief: "Who uses/calls a symbol" },
    parameters: {
        flags: {
            ...scopeFlagParameters,
            ...outputFlagParameters,
            kind: {
                kind: "parsed",
                parse: buildChoiceParser(["call", "import", "type", "write"] as const),
                optional: true,
                brief: "Narrow the reference kind",
            },
        },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Symbol name", placeholder: "symbol" }] },
    },
    async func(this: CommandContext, flags: RefsFlags, symbol: string) {
        await runSearch(this, "refs", symbol, flags, flags.kind !== undefined ? { refKind: flags.kind } : {});
    },
});
