/* `fileq stamps`: each document format's current deriver stamp, so a caller that cannot hash (the daemon's shadow keeper) can tell a shadow an upgraded or newly OCR-capable reader would write differently. */
import { buildCommand, type CommandContext } from "@stricli/core";
import { DERIVERS } from "../lib/derive.js";
import { deriverStamp } from "../lib/derivers/deriver.js";
import { DOCUMENT_FORMATS } from "../lib/formats.js";

export const stampsCommand = buildCommand({
    docs: { brief: "Print each document format's current deriver stamp as one JSON object" },
    parameters: { positional: { kind: "tuple", parameters: [] } },
    func(this: CommandContext) {
        const stamps = Object.fromEntries([...DOCUMENT_FORMATS].map((format) => [format, deriverStamp(DERIVERS[format])]));
        this.process.stdout.write(`${JSON.stringify(stamps)}\n`);
    },
});
