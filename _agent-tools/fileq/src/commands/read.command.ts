/* `fileq read <file>` (also the default command): one file as markdown — a capsule line saying what happened, the content up to a token budget; `--plain` is the body alone, whole, for a program (git's textconv) rather than an agent. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { type ErrorCode, failure, shellWord } from "@intentic/agent-cli/errors";
import { countParser } from "@intentic/agent-cli/flags";
import { capsule, clip, type Whole } from "@intentic/agent-cli/output";
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
            const { body, whole } = await printable(result, absPath);
            this.process.stdout.write("---\n");
            this.process.stdout.write(withFinalNewline(clip(body, flags.budget, whole)));
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
    // A path the shadow tree refuses (an agent's worktree, the reference shelf) is still a file someone may read: it
    // gets no sidecar, only the content cache, like a file outside the workspace.
    if (outcome.kind === "skipped" && (outcome.reason === "outside-workspace" || outcome.reason === "ignored-path")) {
        return readOutsideWorkspace(root, absPath);
    }
    return fromOutcome(outcome, absPath);
};

const fromOutcome = async (outcome: Outcome, absPath: string): Promise<ReadResult | undefined> => {
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
            process.stdout.write(await refusal(outcome.relPath, absPath, reason));
            return undefined;
        }
    }
};

// Why a read failed, as a code and the step that gets further. The reasons are derive.ts's: `missing`, `unsupported`,
// `too-large (N MB)`, `unreadable (EACCES)`, `derive-failed (docx): …`. The daemon reads the reason back off the
// error line's `cannot read <path>: ` (_sandbox/sandbox/src/derived/derived-blob.ts), so that wording stays.
const refusal = async (shown: string, absPath: string, reason: string): Promise<string> => {
    const [code, next] = await refusalKind(absPath, reason);
    return failure("fileq", code, `cannot read ${shown}: ${reason}`, next);
};

const refusalKind = async (absPath: string, reason: string): Promise<readonly [ErrorCode, string | undefined]> => {
    if (reason === "missing") {
        return ["not_found", `ls ${shellWord(dirname(absPath))}`];
    }
    if (reason === "unsupported") {
        return ["unsupported", "fileq --help lists the formats it reads; read a text file directly"];
    }
    if (reason.startsWith("too-large")) {
        return ["too_large", undefined];
    }
    if (reason.startsWith("unreadable")) {
        return ["unreadable", `ls -l ${shellWord(absPath)}`];
    }
    // A document that will not open: a check names what is wrong with it (damaged, password-protected), and is loaded
    // only on this path.
    const failed = /^derive-failed \((\w+)\)/.exec(reason)?.[1];
    const { CHECKABLE } = await import("../lib/check/check.js");
    return ["unreadable", CHECKABLE.some((format) => format === failed) ? `fileq check ${shellWord(absPath)}` : undefined];
};

// A file outside the workspace has no sidecar: the content cache alone keeps its rendering, and its entry is what `saved:`
// names, so git's textconv reading the same blob twice derives it once.
const readOutsideWorkspace = async (root: string | undefined, absPath: string): Promise<ReadResult | undefined> => {
    const outcome = await renderByContent(root, absPath);
    if (outcome.kind === "failed") {
        // The content cache cannot tell a missing file from one in no format it reads; the file system can.
        const reason = outcome.reason === "unsupported or missing" ? (existsSync(absPath) ? "unsupported" : "missing") : outcome.reason;
        process.stdout.write(await refusal(absPath, absPath, reason));
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

// The body to print and where its continuation is read: the saved rendering's own text below its front matter, so the
// line a cut names is the line that file shows there; `--plain`'s output when nothing was saved or it cannot be read back.
const printable = async (result: ReadResult, absPath: string): Promise<{ body: string; whole: Whole }> => {
    // allow(silent-catch): a rendering that cannot be read back is still printed, from memory, with `--plain` as its rest.
    const saved = result.savedPath === undefined ? undefined : await readFile(result.savedPath, "utf8").catch(() => undefined);
    if (result.savedPath === undefined || saved === undefined) {
        return { body: result.body, whole: { command: `fileq read --plain ${shellWord(absPath)}` } };
    }
    const fence = saved.startsWith("---\n") ? saved.indexOf("\n---\n", 4) : -1;
    const start = fence === -1 ? 0 : fence + "\n---\n".length;
    // The front matter's lines, plus one: the line the body starts on.
    const firstLine = saved.slice(0, start).split("\n").length;
    return { body: saved.slice(start), whole: { file: result.savedPath, firstLine } };
};

// A document's last line is content, and a sidecar body need not end in a newline; a clipped one already does.
const withFinalNewline = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
