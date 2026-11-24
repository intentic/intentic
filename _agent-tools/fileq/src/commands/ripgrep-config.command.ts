/* `fileq ripgrep-config`: the ripgrep config that makes plain `rg` search documents' text through fileq's preprocessor. */
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { buildCommand, type CommandContext } from "@stricli/core";
import { ripgrepConfigLines } from "../lib/formats.js";

interface RipgrepConfigFlags {
    readonly pre?: string;
}

// The preprocessor this package ships, beside dist/ and src/ alike: bin/fileq-rg-pre.
const ownPreprocessor = (): string => join(packageRoot(import.meta.url), "bin/fileq-rg-pre");

export const ripgrepConfigCommand = buildCommand({
    docs: {
        brief: "Print a ripgrep config (for RIPGREP_CONFIG_PATH) that searches pdf, docx, xlsx, pptx, odt, ods, odp, rtf and epub as text",
        fullDescription: `Point RIPGREP_CONFIG_PATH at this output and \`rg pattern .\` searches documents too, each hit under the
document's own path with its page: \`docs/terms.pdf:345:[p. 12] …\`. Lines under a page heading carry
\`[p. N] \`, under a slide heading \`[slide N] \`. The preprocessor prints a document's fresh shadow
(.intentic/local/cache/derived/<path>.md) with no Node start, and falls back to \`fileq read --plain\`.`,
    },
    parameters: {
        flags: {
            pre: { kind: "parsed", parse: String, optional: true, brief: "The preprocessor's path (default: this package's bin/fileq-rg-pre)" },
        },
        positional: { kind: "tuple", parameters: [] },
    },
    func(this: CommandContext, flags: RipgrepConfigFlags) {
        this.process.stdout.write(`${ripgrepConfigLines(flags.pre ?? ownPreprocessor()).join("\n")}\n`);
    },
});
