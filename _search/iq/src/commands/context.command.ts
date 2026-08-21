import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const context = buildCommand({
    docs: { brief: "Expand around an anchor, the enclosing function/class of path:line" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Anchor as path:line", placeholder: "path:line" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, anchor: string) {
        await runSearch(this, "context", anchor, flags, {});
    },
});
