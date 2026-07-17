import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const ast = buildCommand({
    docs: { brief: "Structural AST pattern search — $X one node, $$$ any nodes (e.g. 'await $FN($$$)')" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "ast-grep pattern", placeholder: "pattern" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, pattern: string) {
        // --lang doubles as the pattern's parse language; the engine requires exactly one for ast.
        await runSearch(this, "ast", pattern, flags, flags.lang?.[0] !== undefined ? { astLang: flags.lang[0] } : {});
    },
});
