import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const who = buildCommand({
    docs: { brief: "Blame an anchor, commit, author, date, message for path:line[-line]" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Anchor as path:line or path:line-line", placeholder: "path:line" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, anchor: string) {
        await runSearch(this, "who", anchor, flags, {});
    },
});
