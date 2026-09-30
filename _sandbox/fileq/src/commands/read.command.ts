/* `fileq read <file>` (also the default command): one file as markdown — a capsule line saying what happened, the content up to a token budget; `--plain` is the body alone, whole, for a program (git's textconv) rather than an agent. */
import { basename, resolve } from "node:path";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule, clip } from "@intentic/agent-cli/output";
import { estimateTokens } from "@intentic/base/format";
import { buildCommand, type CommandContext } from "@stricli/core";
import { deriverStamp } from "../lib/derivers/deriver.js";
import { DERIVERS, ensureSidecar, renderByContent, type Outcome } from "../lib/derive.js";
import { workspaceRoot } from "../lib/env.js";

interface ReadFlags {
    readonly budget: number;
    readonly json: boolean;
    readonly plain: boolean;
}

export const readCommand = buildCommand({
    docs: { brief: "One file as clean markdown: budgeted on stdout, whole in its sidecar" },
    parameters: {
        flags: {
            budget: { kind: "parsed", parse: countParser, default: "4000", brief: "Max stdout tokens; 0 prints only the capsule" },
            json: { kind: "boolean", default: false, brief: "Machine-readable result on stdout" },
            plain: { kind: "boolean", default: false, brief: "The markdown alone, whole and unbudgeted (git textconv)" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "The file to read (relative paths resolve against the cwd)", placeholder: "file" }],
        },
    },
    async func(this: CommandContext, flags: ReadFlags, file: string) {
        const absPath = resolve(file);
        const root = workspaceRoot();
        const result = root === undefined ? await readOutsideWorkspace(undefined, absPath) : await readInWorkspace(root, absPath);
        if (result === undefined) {
            process.exitCode = 1;
            return;
        }
        if (flags.plain) {
            this.process.stdout.write(result.body === "" ? "" : `${result.body}\n`);
            return;
        }
        if (flags.json) {
            this.process.stdout.write(
                `${JSON.stringify({ file: absPath, format: result.format, deriver: result.deriver, tokens: result.tokens, path: result.savedPath, source: result.source, notes: result.notes })}\n`,
            );
            return;
        }
        const fields = [result.title ?? basename(absPath), result.format, `${result.tokens} tokens`, result.source];
        const notes = result.savedPath === undefined ? [...result.notes, "nothing saved: the rendering cache could not be written"] : result.notes;
        this.process.stdout.write(capsule("fileq", fields, notes));
        if (result.savedPath !== undefined) {
            this.process.stdout.write(`saved: ${result.savedPath}\n`);
        }
        if (flags.budget > 0 && result.body !== "") {
            const whole = result.savedPath ?? `the output of \`fileq read --plain ${absPath}\``;
            this.process.stdout.write("---\n");
            this.process.stdout.write(withFinalNewline(clip(result.body, flags.budget, whole, "document")));
        }
    },
});

interface ReadResult {
    readonly format: string;
    // The reader's stamp (`docx v1`), the same one a sidecar's front matter names, so a caller can keep it beside the text.
    readonly deriver: string;
    readonly body: string;
    readonly tokens: number;
    /** The file holding the whole rendering; undefined when the cache could not be written. */
    readonly savedPath: string | undefined;
    readonly source: "derived" | "fresh";
    readonly title?: string | undefined;
    readonly notes: string[];
}

const readInWorkspace = async (root: string, absPath: string): Promise<ReadResult | undefined> => {
    const outcome = await ensureSidecar(root, absPath);
    if (outcome.kind === "skipped" && outcome.reason === "outside-workspace") {
        return readOutsideWorkspace(root, absPath);
    }
    return fromOutcome(outcome);
};

const fromOutcome = (outcome: Outcome): ReadResult | undefined => {
    switch (outcome.kind) {
        case "derived":
            return {
                format: outcome.format,
                deriver: deriverStamp(DERIVERS[outcome.format]),
                body: outcome.body,
                tokens: outcome.tokens,
                savedPath: outcome.sidecarPath,
                source: "derived",
                title: outcome.doc.title,
                notes: outcome.doc.notes,
            };
        case "fresh":
            return {
                format: outcome.format,
                deriver: deriverStamp(DERIVERS[outcome.format]),
                body: outcome.body,
                tokens: outcome.tokens,
                savedPath: outcome.sidecarPath,
                source: "fresh",
                notes: [],
            };
        case "removed":
        case "skipped": {
            const reason = outcome.kind === "removed" ? "missing" : outcome.reason;
            process.stdout.write(`fileq: cannot read ${outcome.relPath}: ${reason}\n`);
            return undefined;
        }
    }
};

// A file outside the workspace has no sidecar: the content cache alone keeps its rendering, and its entry is what `saved:`
// names, so git's textconv reading the same blob twice derives it once.
const readOutsideWorkspace = async (root: string | undefined, absPath: string): Promise<ReadResult | undefined> => {
    const outcome = await renderByContent(root, absPath);
    if (outcome.kind === "failed") {
        process.stdout.write(`fileq: cannot read ${absPath}: ${outcome.reason}\n`);
        return undefined;
    }
    return {
        format: outcome.format,
        deriver: deriverStamp(DERIVERS[outcome.format]),
        body: outcome.doc.markdown,
        tokens: estimateTokens(outcome.doc.markdown),
        savedPath: outcome.cachedPath,
        source: outcome.kind,
        title: outcome.doc.title,
        notes: outcome.doc.notes,
    };
};

// A document's last line is content, and a sidecar body need not end in a newline; a clipped one already does.
const withFinalNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
