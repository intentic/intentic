/* `fileq check <file>`: a document's structural problems, each with where it is, so an agent can fix what it produced before a person opens it. */
import { basename, resolve } from "node:path";
import { capsule } from "@intentic/agent-cli/output";
import { neutralizeOutsideText } from "@intentic/base/outside-text";
import { buildCommand, type CommandContext } from "@stricli/core";
import type { CheckReport, Finding } from "../lib/check/finding.js";

interface CheckFlags {
    readonly json: boolean;
}

// Past this many findings of one rule, the rest are counted: forty identical "#REF!" lines say no more than ten.
const SHOWN_PER_RULE = 12;

// Document text reaches these lines (a shape's name, a link's words, an excerpt), so they are folded like a sidecar.
const line = (finding: Finding): string => {
    const where = finding.where === "" ? "" : `${finding.where}: `;
    return neutralizeOutsideText(`${finding.severity === "error" ? "error  " : "warning"} ${where}${finding.message}`);
};

const listing = (findings: readonly Finding[]): string[] => {
    const shown = new Map<string, number>();
    const lines: string[] = [];
    const hidden = new Map<string, number>();
    // Errors first, then warnings, each in the document's own order.
    for (const finding of [...findings.filter((item) => item.severity === "error"), ...findings.filter((item) => item.severity === "warning")]) {
        const count = shown.get(finding.rule) ?? 0;
        if (count < SHOWN_PER_RULE) {
            lines.push(line(finding));
            shown.set(finding.rule, count + 1);
        } else {
            hidden.set(finding.rule, (hidden.get(finding.rule) ?? 0) + 1);
        }
    }
    for (const [rule, count] of hidden) {
        lines.push(`… and ${count} more ${rule} (--json lists every one)`);
    }
    return lines;
};

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const tally = (report: CheckReport): string => {
    const errors = report.findings.filter((finding) => finding.severity === "error").length;
    const warnings = report.findings.length - errors;
    if (report.findings.length === 0) {
        return "no problems found";
    }
    return [errors > 0 ? counted(errors, "error") : "", warnings > 0 ? counted(warnings, "warning") : ""].filter((part) => part !== "").join(", ");
};

export const checkCommand = buildCommand({
    docs: { brief: "Lint a docx, pptx, xlsx or pdf for problems a reader would meet; exit 1 on any error" },
    parameters: {
        flags: {
            json: { kind: "boolean", default: false, brief: "Every finding as JSON on stdout" },
        },
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "The document to check (relative paths resolve against the cwd)", placeholder: "file" }],
        },
    },
    async func(this: CommandContext, flags: CheckFlags, file: string) {
        const absPath = resolve(file);
        // Loaded here, not at the top: every fileq run (a derive, a read of a png) imports this module, and only a check
        // needs the checkers.
        const { CHECKABLE, checkFile } = await import("../lib/check/check.js");
        const outcome = await checkFile(absPath);
        if (outcome.kind !== "checked") {
            const reason =
                outcome.kind === "unreadable"
                    ? outcome.reason
                    : `fileq check reads ${CHECKABLE.join(", ")}; this is ${outcome.format ?? "none of them"} (fileq read shows what it holds)`;
            this.process.stdout.write(`fileq: cannot check ${absPath}: ${reason}\n`);
            process.exitCode = 2;
            return;
        }
        const { report } = outcome;
        const errors = report.findings.filter((finding) => finding.severity === "error").length;
        process.exitCode = errors > 0 ? 1 : 0;
        if (flags.json) {
            const findings = report.findings.map((finding) => ({ ...finding, where: neutralizeOutsideText(finding.where), message: neutralizeOutsideText(finding.message) }));
            this.process.stdout.write(`${JSON.stringify({ file: absPath, format: report.format, extent: report.extent, errors, warnings: findings.length - errors, findings, notes: report.notes })}\n`);
            return;
        }
        const fields = [basename(absPath), report.format, ...(report.extent === undefined ? [] : [report.extent]), tally(report)];
        this.process.stdout.write(capsule("fileq", fields, report.notes));
        const lines = listing(report.findings);
        if (lines.length > 0) {
            this.process.stdout.write(`${lines.join("\n")}\n`);
        }
        // A clean lint is about structure; how it looks is a different question with its own command.
        if (errors === 0) {
            this.process.stdout.write(`structure only: look at the ${report.format === "pptx" ? "slides" : "pages"} with \`fileq render ${file}\`\n`);
        }
    },
});
