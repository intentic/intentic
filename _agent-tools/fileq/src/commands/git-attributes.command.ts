/* `fileq git-attributes`: the gitattributes lines that make git's own diffs read documents through fileq (textconv). */
import { buildCommand, type CommandContext } from "@stricli/core";
import { gitAttributeLines } from "../lib/formats.js";

export const gitAttributesCommand = buildCommand({
    docs: {
        brief: "Print gitattributes marking every derivable format `diff=fileq`, for a `diff.fileq.textconv` of `fileq read --plain`",
    },
    parameters: { positional: { kind: "tuple", parameters: [] } },
    func(this: CommandContext) {
        this.process.stdout.write(`${gitAttributeLines().join("\n")}\n`);
    },
});
