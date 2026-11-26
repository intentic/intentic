/* `fileq render <file>`: a document's pages (a deck's slides) as PNG files, one path per line, for an agent to look at with its image reader. */
import { basename, resolve } from "node:path";
import { type ErrorCode, failure } from "@intentic/agent-cli/errors";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule } from "@intentic/agent-cli/output";
import { errnoCode, errorMessage } from "@intentic/base/errors";
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

interface Failure {
    readonly exit: number;
    readonly code: ErrorCode;
    readonly message: string;
    readonly next?: string;
}

// What went wrong, as the exit code the agent-CLI contract gives it: a missing tool or a bad flag is the invocation's
// fault (2); a document that cannot be drawn is "nothing here" (1). Anything else is fileq's own failure (2).
const failureOf = (cause: unknown): Failure => {
    const message = errorMessage(cause);
    if (cause instanceof ToolMissing) {
        // convert.ts words it `<what is missing> … here: <how to get it>`; the second half is the step.
        const at = message.indexOf(" here: ");
        return at === -1
            ? { exit: 2, code: "missing_tool", message }
            : { exit: 2, code: "missing_tool", message: message.slice(0, at + " here".length), next: message.slice(at + " here: ".length) };
    }
    if (cause instanceof BadPages) {
        return { exit: 2, code: "usage", message };
    }
    if (cause instanceof NotRenderable) {
        return { exit: 1, code: "unsupported", message };
    }
    if (cause instanceof ConvertFailed) {
        return { exit: 1, code: "unreadable", message };
    }
    // A file system's refusal (an --out it cannot write) names itself; only a bug is worth reporting.
    return errnoCode(cause) === undefined
        ? { exit: 2, code: "internal", message, next: "this is fileq's own failure, not an empty answer: report it with the command that was run" }
        : { exit: 2, code: "internal", message };
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
            const failed = failureOf(cause);
            this.process.stdout.write(failure("fileq", failed.code, `cannot render ${absPath}: ${failed.message}`, failed.next));
            process.exitCode = failed.exit;
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
