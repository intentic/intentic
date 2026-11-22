import { posix } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";
import type { InstructionNeed, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";
import { opt } from "../../opt.js";

// A standing rule an agent proposes keeping (docs/architecture/needs.md): the owner said it once ("from now on…",
// "remember…"), and an AGENTS.md is what every later conversation is told (agent/prompt/workspace-memory.ts). Those
// files are the owner's own words to every agent, so an agent never writes one itself: the card shows the exact change,
// and a person's approval appends it to the file on the main tree and commits that file on its own. Left uncommitted,
// an approved rule sat among whatever else was dirty, and the owner's next discard took it too (shinobi-society,
// 2026-11-21: a rule approved at 17:12 was gone at 17:16, while its agent told the owner it was in AGENTS.md). Met as
// well when the words are already in the file, however they got there.

export interface InstructionNeedDeps {
    // The file's text on the main tree; undefined when there is none. Throws for a path that leads out of the workspace.
    readonly read: (file: string) => Promise<string | undefined>;
    // Writes the file and commits exactly it under `subject`, unless it already held edits of the owner's own, which are
    // theirs to commit; true when it was committed.
    readonly write: (file: string, text: string, subject: string) => Promise<boolean>;
    // Whether the folder the file sits in exists on the main tree.
    readonly folder: (file: string) => Promise<boolean>;
}

// Lines of the file shown above the addition, as a unified diff's context.
const CONTEXT = 3;

// The file as the workspace names it, or why not: an AGENTS.md (or a folder, meaning its AGENTS.md), relative to the
// root, never climbing out of it.
export const instructionFile = (raw: string): { readonly file: string } | { readonly problem: string } => {
    const trimmed = raw.trim().replaceAll("\\", "/");
    if (trimmed.startsWith("/")) {
        return { problem: `${raw} is an absolute path; name the file relative to the workspace root` };
    }
    const normal = posix.normalize(trimmed === "" ? "." : trimmed).replace(/\/$/, "");
    const file = posix.basename(normal) === MEMORY_FILE ? normal : normal === "." ? MEMORY_FILE : `${normal}/${MEMORY_FILE}`;
    if (file === ".." || file.startsWith("../")) {
        return { problem: `${raw} is outside the workspace` };
    }
    return { file };
};

const linesOf = (text: string): string[] => {
    const lines = text.split("\n");
    return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

const isBullet = (line: string | undefined): boolean => line !== undefined && /^\s*[-*] /.test(line);

// The file with the rule added at its end: under the last bullet when both are bullets, a paragraph of its own otherwise.
export const withRule = (current: string | undefined, text: string): string => {
    const rule = text.trim();
    const kept = (current ?? "").replace(/\s+$/, "");
    if (kept === "") {
        return `${rule}\n`;
    }
    const joint = isBullet(linesOf(kept).at(-1)) && isBullet(rule.split("\n")[0]) ? "\n" : "\n\n";
    return `${kept}${joint}${rule}\n`;
};

// The change as one unified hunk: what the two texts share up front is context, the rest of the old text goes, the rest
// of the new one comes. An append differs only at the end, so that is the whole change.
export const appendDiff = (file: string, before: string | undefined, after: string): string => {
    const old = before === undefined ? [] : linesOf(before);
    const next = linesOf(after);
    let same = 0;
    while (same < old.length && same < next.length && old[same] === next[same]) {
        same += 1;
    }
    const start = Math.max(0, same - CONTEXT);
    const context = old.slice(start, same);
    const removed = old.slice(same);
    const added = next.slice(same);
    const range = (count: number): string => `${count === 0 ? start : start + 1},${count}`;
    return [
        before === undefined ? "--- /dev/null" : `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -${range(context.length + removed.length)} +${range(context.length + added.length)} @@`,
        ...context.map((line) => ` ${line}`),
        ...removed.map((line) => `-${line}`),
        ...added.map((line) => `+${line}`),
    ].join("\n");
};

// Whether the file already says it, word for word up to spacing.
const holds = (current: string | undefined, text: string): boolean => {
    const squeeze = (value: string): string => value.replace(/\s+/g, " ").trim();
    return current !== undefined && squeeze(current).includes(squeeze(text));
};

const clipped = (text: string): string => {
    const first = text.trim().split("\n")[0]?.replace(/^\s*[-*] /, "") ?? "";
    return first.length > 70 ? `${first.slice(0, 69)}…` : first;
};

// How the rule stands once the file says it: already there, written and committed on its own, or written beside the
// owner's own uncommitted edits to that file, which only they can commit.
type Kept = "already" | "committed" | "uncommitted";

const metFor = (subject: Pick<InstructionNeed, "file">, kept: Kept): Met => {
    const below = posix.dirname(subject.file) === "." ? "the workspace root" : posix.dirname(subject.file);
    const told = kept === "uncommitted" ? "from its next turn; an isolated one once the file is committed" : "from its next turn";
    return {
        result:
            kept === "already"
                ? `${subject.file} already holds this rule.`
                : kept === "committed"
                  ? `The rule is in ${subject.file} now, committed on its own on the main line.`
                  : `The rule is in ${subject.file} now, in the owner's tree, uncommitted: the file held their own unsaved edits, so it waits for them to commit it.`,
        use: [`Follow it from now on in this conversation too. Every conversation that starts at or below ${below} is told it ${told}.`, "Do not add it to the file yourself as well."],
    };
};

// The commit an approved rule is kept under: what it says, as the card's title clips it.
const ruleCommitSubject = (file: string, text: string): string => `Instructions: remember in ${file}: ${clipped(text)}`;

export const instructionNeed = (deps: InstructionNeedDeps): NeedKindHandler => {
    const subjectOf = (need: Need): InstructionNeed | undefined => (need.subject.kind === "instruction" ? need.subject : undefined);

    const resolve = async (ask: NeedAsk, _context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "instruction") {
            return { kind: "refused", code: "invalid", message: "Not an instruction ask." };
        }
        const named = instructionFile(ask.file);
        if ("problem" in named) {
            return { kind: "refused", code: "invalid_file", message: `Nothing was proposed: ${named.problem}.` };
        }
        const { file } = named;
        if (!(await deps.folder(file))) {
            return { kind: "refused", code: "invalid_file", message: `Nothing was proposed: there is no folder ${posix.dirname(file)} in the workspace.` };
        }
        const current = await deps.read(file);
        if (holds(current, ask.text)) {
            return { kind: "met", message: metFor({ file }, "already").result };
        }
        const text = ask.text.trim();
        const subject: InstructionNeed = {
            kind: "instruction",
            file,
            text,
            diff: appendDiff(file, current, withRule(current, text)),
            ...opt("creates", current === undefined ? true : undefined),
        };
        return { kind: "raise", subject, title: `Remember in ${file}: ${clipped(text)}` };
    };

    return {
        resolve,
        // Met once the file says it, whoever wrote it there: the owner pasting it in by hand closes the card too.
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            return subject !== undefined && holds(await deps.read(subject.file), subject.text) ? metFor(subject, "already") : undefined;
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A rule is answered by approving it, or declined." };
            }
            // Read again: the file may have moved since the card was drawn. The addition is the same either way.
            const current = await deps.read(subject.file);
            if (holds(current, subject.text)) {
                return { status: "met", ...metFor(subject, "already") };
            }
            const committed = await deps.write(subject.file, withRule(current, subject.text), ruleCommitSubject(subject.file, subject.text));
            return { status: "met", ...metFor(subject, committed ? "committed" : "uncommitted") };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "instruction" ? `${subject.file}\n${subject.text.replace(/\s+/g, " ")}` : ""),
    };
};
