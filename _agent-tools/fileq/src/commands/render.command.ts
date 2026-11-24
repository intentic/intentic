/* `fileq render <file>`: a document's pages (a deck's slides) as PNG files, one path per line, for an agent to look at with its image reader. */
import { basename, resolve } from "node:path";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule } from "@intentic/agent-cli/output";
import { errorMessage } from "@intentic/base/errors";
import { buildCommand, type CommandContext } from "@stricli/core";
import { workspaceRoot } from "../lib/env.js";
import { ConvertFailed, ToolMissing } from "../lib/render/convert.js";
import { BadPages, describePages, parsePages } from "../lib/render/pages.js";
import { DEFAULT_SIZE, NotRenderable, renderDocument, type RenderResult } from "../lib/render/render.js";

interface RenderFlags {
    readonly pages: string | undefined;
    readonly out: string | undefined;
    readonly size: number;
    readonly json: boolean;
}

// What went wrong, as the exit code the agent-CLI contract gives it: a missing tool or a bad flag is the invocation's
// fault (2); a document that cannot be drawn is "nothing here" (1).
const failure = (cause: unknown): { code: number; message: string } | undefined => {
    if (cause instanceof ToolMissing || cause instanceof BadPages) {
        return { code: 2, message: cause.message };
    }
    if (cause instanceof NotRenderable || cause instanceof ConvertFailed) {
        return { code: 1, message: cause.message };
    }
    return undefined;
};

const summary = (file: string, result: RenderResult): string => {
    const drawn = result.images.map((image) => image.page);
    const fields = [
        basename(file),
        result.format,
        `${result.total} ${result.unit}${result.total === 1 ? "" : "s"}`,
        drawn.length === 0 ? "nothing drawn" : `drew ${result.unit}${drawn.length === 1 ? "" : "s"} ${describePages(drawn)}`,
        result.reused ? "unchanged since the last render" : "rendered",
    ];
    return capsule("fileq", fields, result.notes);
};

export const renderCommand = buildCommand({
    docs: { brief: "Draw a document's pages or slides as PNG files and print their paths, to look at with an image reader" },
    parameters: {
        flags: {
            pages: { kind: "parsed", parse: String, optional: true, brief: "Which pages or slides: 3, 1-3, 2,5,7-9, 7- (default: the first 20)" },
            out: { kind: "parsed", parse: String, optional: true, brief: "Folder for the PNGs (default: .intentic/local/cache/rendered/<path>/ in the workspace)" },
            size: { kind: "parsed", parse: countParser, default: String(DEFAULT_SIZE), brief: "Longest side of each image, in pixels" },
            json: { kind: "boolean", default: false, brief: "Machine-readable result on stdout" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "The document to draw (relative paths resolve against the cwd)", placeholder: "file" }],
        },
    },
    async func(this: CommandContext, flags: RenderFlags, file: string) {
        const absPath = resolve(file);
        let result: RenderResult;
        try {
            const pages = flags.pages === undefined ? undefined : parsePages(flags.pages);
            const size = Math.max(64, Math.round(flags.size));
            result = await renderDocument({ absPath, pages, outDir: flags.out === undefined ? undefined : resolve(flags.out), size }, workspaceRoot());
        } catch (cause) {
            const known = failure(cause);
            this.process.stdout.write(`fileq: cannot render ${absPath}: ${known?.message ?? errorMessage(cause)}\n`);
            process.exitCode = known?.code ?? 2;
            return;
        }
        process.exitCode = result.images.length > 0 ? 0 : 1;
        if (flags.json) {
            this.process.stdout.write(
                `${JSON.stringify({ file: absPath, format: result.format, unit: result.unit, total: result.total, images: result.images, reused: result.reused, notes: result.notes })}\n`,
            );
            return;
        }
        this.process.stdout.write(summary(absPath, result));
        this.process.stdout.write(result.images.map((image) => `${image.path}\n`).join(""));
    },
});
