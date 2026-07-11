import { execSync } from "node:child_process";
import type { Anchor } from "../schema.js";

export interface Verdict {
    readonly success: boolean;
    readonly detail: string;
}

const LINE_WINDOW = 48;
const DEFAULT_TOLERANCE = 15;

// The agent may print absolute or relative paths — match on the last two segments.
const mentionOf = (file: string): string => file.split("/").slice(-2).join("/");

export const anchorHit = (answer: string, anchor: Anchor): boolean => {
    const mention = mentionOf(anchor.file);
    let index = answer.indexOf(mention);
    if (index === -1) {
        return false;
    }
    if (anchor.line === undefined) {
        return true;
    }
    const tolerance = anchor.tolerance ?? DEFAULT_TOLERANCE;
    while (index !== -1) {
        // ":42", "#L42", "L42", "line 42", "Line 42", "lines 42-51" — anywhere in a short window after the mention.
        const window = answer.slice(index + mention.length, index + mention.length + LINE_WINDOW);
        for (const match of window.matchAll(/(?:[:#]L?|\blines? |\bL)(\d+)/gi)) {
            if (Math.abs(Number(match[1]) - anchor.line) <= tolerance) {
                return true;
            }
        }
        index = answer.indexOf(mention, index + 1);
    }
    return false;
};

export const gradeAnchors = (answer: string, grader: { anchors: readonly Anchor[]; requireAll?: boolean | undefined }): Verdict => {
    const hits = grader.anchors.map((anchor) => ({ anchor, hit: anchorHit(answer, anchor) }));
    const success = grader.requireAll === true ? hits.every((entry) => entry.hit) : hits.some((entry) => entry.hit);
    const detail = hits
        .map((entry) => `${entry.hit ? "✓" : "✗"} ${entry.anchor.file}${entry.anchor.line === undefined ? "" : `:${entry.anchor.line}`}`)
        .join(", ");
    return { success, detail };
};

export const gradeTest = (cwd: string, grader: { command: string; timeoutMs: number }): Verdict => {
    try {
        execSync(grader.command, { cwd, timeout: grader.timeoutMs, stdio: "pipe" });
        return { success: true, detail: `\`${grader.command}\` exited 0` };
    } catch (error) {
        const output = error instanceof Error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
        const tail = output.trim().split("\n").slice(-3).join(" | ");
        return { success: false, detail: `\`${grader.command}\` failed: ${tail.slice(0, 300)}` };
    }
};
