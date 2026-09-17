/* `fileq read <file>` (also the default command): one file as markdown — a capsule line saying what happened, the content up to a token budget; `--plain` is the body alone, whole, for a program (git's textconv) rather than an agent. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { errorMessage } from "@intentic/base/errors";
import { deriverStamp, neutralizeDoc, type DerivedDoc } from "../lib/derivers/deriver.js";
import { detectFormat } from "../lib/formats.js";
import { DERIVERS, ensureSidecar, type Outcome } from "../lib/derive.js";
import { defaultOutDir, tokensOf, workspaceRoot } from "../lib/env.js";
import { numberParser } from "../lib/flags.js";

interface ReadFlags {
    readonly budget: number;
    readonly json: boolean;
    readonly plain: boolean;
}

export const readCommand = buildCommand({
    docs: { brief: "One file as clean markdown: budgeted on stdout, whole in its sidecar" },
    parameters: {
        flags: {
            budget: { kind: "parsed", parse: numberParser, default: "4000", brief: "Max stdout tokens; 0 prints only the capsule" },
            json: { kind: "boolean", default: false, brief: "Machine-readable result on stdout" },
            plain: { kind: "boolean", default: false, brief: "The markdown alone, whole and unbudgeted; nothing saved for a file outside the workspace (git textconv)" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "The file to read (relative paths resolve against the cwd)", placeholder: "file" }],
        },
    },
    async func(this: CommandContext, flags: ReadFlags, file: string) {
        const absPath = resolve(file);
        const root = workspaceRoot();
        const save = !flags.plain;
        const result = root === undefined ? await readOutsideWorkspace(absPath, save) : await readInWorkspace(root, absPath, save);
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
        this.process.stdout.write(`fileq: ${result.title ?? basename(absPath)} · ${result.format} · ${result.tokens} tokens · ${result.source}\n`);
        for (const note of result.notes) {
            this.process.stdout.write(`note: ${note}\n`);
        }
        this.process.stdout.write(`saved: ${result.savedPath}\n`);
        if (flags.budget > 0 && result.body !== "") {
            this.process.stdout.write("---\n");
            this.process.stdout.write(clip(result.body, flags.budget, result.savedPath));
        }
    },
});

interface ReadResult {
    readonly format: string;
    // The reader's stamp (`docx v1`), the same one a sidecar's front matter names, so a caller can keep it beside the text.
    readonly deriver: string;
    readonly body: string;
    readonly tokens: number;
    readonly savedPath: string;
    readonly source: "derived" | "fresh";
    readonly title?: string | undefined;
    readonly notes: string[];
}

const readInWorkspace = async (root: string, absPath: string, save: boolean): Promise<ReadResult | undefined> => {
    const outcome = await ensureSidecar(root, absPath);
    if (outcome.kind === "skipped" && outcome.reason === "outside-workspace") {
        return readOutsideWorkspace(absPath, save);
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

/* Outside a workspace there is no sidecar tree; derive in memory and save the whole thing under the XDG, unless the
   caller wants only the text (`--plain`: git hands textconv a temp file per blob, and a saved copy of each would pile up). */
const readOutsideWorkspace = async (absPath: string, save: boolean): Promise<ReadResult | undefined> => {
    const format = await detectFormat(absPath).catch(() => undefined);
    if (format === undefined) {
        process.stdout.write(`fileq: cannot read ${absPath}: unsupported or missing\n`);
        return undefined;
    }
    // The same outcome a corrupt file gets inside a workspace (ensureSidecar's loud skip): a notebook that is
    // not JSON, a docx that is not a zip, answers with the reason and exit 1, never a stack trace.
    let doc: DerivedDoc;
    try {
        doc = neutralizeDoc(await DERIVERS[format].derive(absPath));
    } catch (error) {
        process.stdout.write(`fileq: cannot read ${absPath}: derive-failed (${format}): ${errorMessage(error).split("\n")[0]}\n`);
        return undefined;
    }
    const outDir = defaultOutDir();
    const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 8);
    const savedPath = join(
        outDir,
        `${basename(absPath)
            .toLowerCase()
            .replaceAll(/[^a-z0-9.]+/g, "-")}-${hash}.md`,
    );
    if (save) {
        await mkdir(outDir, { recursive: true });
        await writeFile(savedPath, `${doc.markdown}\n`);
    }
    return {
        format,
        deriver: deriverStamp(DERIVERS[format]),
        body: doc.markdown,
        tokens: tokensOf(doc.markdown),
        savedPath,
        source: "derived",
        title: doc.title,
        notes: doc.notes,
    };
};

const clip = (markdown: string, budgetTokens: number, path: string): string => {
    if (tokensOf(markdown) <= budgetTokens) {
        return `${markdown}\n`;
    }
    const cut = markdown.slice(0, budgetTokens * 4);
    const atLine = cut.slice(0, cut.lastIndexOf("\n") + 1);
    return `${atLine}\n[cut at ${budgetTokens} of ${tokensOf(markdown)} tokens: Read ${path} for the whole document]\n`;
};
