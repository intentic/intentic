import { z } from "zod";
import { REVIEW_FINDINGS_MAX, REVIEW_TEXT_MAX, type ReviewFinding } from "@intentic/sandbox-contract/events/review";
import { splitTurnPreamble } from "../../../sessions/vocabulary/prompt-envelope.js";
import { opt } from "../../../opt.js";
import type { AppServerNotification, CodexEvent, CodexSkill } from "../codex-app-server.js";

// What a `/command` does on a Codex thread. A published skill (skills/list) is sent as a structured skill input, so
// app-server loads it rather than the model guessing. `/review` is Codex's own reviewer: sent as review/start in place of
// turn/start, it ends on an exitedReviewMode item whose text carries the reviewer's word and its findings, read here into
// prose for the bubble and the findings card (events/review.ts).

// Resolves a /command prompt against the thread's published skills, read after the daemon's notes (which every worktree
// turn carries and the text keeps), so app-server loads the skill. Undefined for a slash-led path or a plan turn.
export const skillInput = (prompt: string, skills: readonly CodexSkill[]): { readonly skill: CodexSkill; readonly text: string } | undefined => {
    const { words } = splitTurnPreamble(prompt);
    const named = /^\/([^\s/]+)[ \t]*/.exec(words);
    const skill = named === null ? undefined : skills.find((candidate) => candidate.name === named[1]);
    const notes = prompt.slice(0, prompt.length - words.length);
    return skill === undefined || named === null ? undefined : { skill, text: `${notes}${words.slice(named[0].length)}` };
};

const REVIEW = "review";

// Published beside the skills for the `/` popover, unless a skill of the thread's already answers to the name. Shaped as
// a skill only so it rides the same list; it has no file, and is never sent as a skill input.
const REVIEW_COMMAND: CodexSkill = {
    name: REVIEW,
    description: "Review the changes with Codex's reviewer: uncommitted by default, or `branch <name>`, `commit <sha>`, or what to look at",
    path: "",
};

export const publishedCommands = (skills: readonly CodexSkill[]): readonly CodexSkill[] =>
    skills.some((skill) => skill.name === REVIEW) ? skills : [...skills, REVIEW_COMMAND];

// What review/start reviews, as app-server's ReviewTarget spells it.
export type CodexReviewTarget =
    | { readonly type: "uncommittedChanges" }
    | { readonly type: "baseBranch"; readonly branch: string }
    | { readonly type: "commit"; readonly sha: string; readonly title: null }
    | { readonly type: "custom"; readonly instructions: string };

const SHA = /^[0-9a-f]{7,40}$/i;

// `/review` alone reviews the uncommitted changes; `branch <name>` the changes against a base branch, `commit <sha>` (or
// the bare sha) one commit; anything else is what the reviewer is asked to look at.
export const reviewTargetOf = (words: string): CodexReviewTarget => {
    const text = words.trim();
    const [first = "", second, ...more] = text.split(/\s+/);
    const one = second !== undefined && more.length === 0 ? second : undefined;
    if (text === "" || /^uncommitted$/i.test(text)) {
        return { type: "uncommittedChanges" };
    }
    if (/^(?:branch|base)$/i.test(first) && one !== undefined) {
        return { type: "baseBranch", branch: one };
    }
    const sha = /^commit$/i.test(first) ? one : second === undefined ? first : undefined;
    return sha !== undefined && SHA.test(sha) ? { type: "commit", sha, title: null } : { type: "custom", instructions: text };
};

// The review a prompt asks for, when its words (after the daemon's notes) open with `/review` and no skill of the thread
// claims that name; undefined for every other prompt.
export const reviewTargetIn = (prompt: string, skills: readonly CodexSkill[]): CodexReviewTarget | undefined => {
    const named = /^\/review(?:\s+([\s\S]*))?$/.exec(splitTurnPreamble(prompt).words.trim());
    return named === null || skills.some((skill) => skill.name === REVIEW) ? undefined : reviewTargetOf(named[1] ?? "");
};

// app-server renders a review as the reviewer's word, then a "Full review comments:" block of `- [P1] title — /abs/path:3-7`
// lines with each body indented beneath (codex-rs review_format.rs, checked against the 0.163 binary's strings).
const HEADER = /^(?:Full review comments|Review comments?):[ \t]*$/m;
const ITEM = /^- (?:\[[ x]\] )?(.+?) — (.+?):(\d+)(?:-(\d+))?\s*$/;
const PRIORITY = /^\[P([0-3])\]\s*/;
// What app-server says when the reviewer wrote nothing it could read: not a clean review.
const NO_REVIEW = "Reviewer failed to output a response.";

const cut = (text: string): string => (text.length <= REVIEW_TEXT_MAX ? text : `${text.slice(0, REVIEW_TEXT_MAX - 1)}…`);

const findingOf = (match: RegExpExecArray, body: readonly string[]): ReviewFinding => {
    const titled = match[1] ?? "";
    const priority = PRIORITY.exec(titled);
    const line = Number(match[3]);
    const end = match[4] === undefined ? undefined : Number(match[4]);
    const text = body.join("\n").trim();
    return {
        file: match[2] ?? "",
        ...opt("line", line > 0 ? line : undefined),
        ...opt("endLine", end !== undefined && end > line ? end : undefined),
        summary: cut(priority === null ? titled : titled.slice(priority[0].length)),
        ...opt("priority", priority === null ? undefined : Number(priority[1])),
        ...opt("body", text === "" ? undefined : cut(text)),
    };
};

const findingsIn = (block: string): ReviewFinding[] => {
    const findings: ReviewFinding[] = [];
    let open: { readonly match: RegExpExecArray; readonly body: string[] } | undefined;
    for (const line of block.split("\n")) {
        const match = ITEM.exec(line);
        if (match !== null) {
            if (open !== undefined) {
                findings.push(findingOf(open.match, open.body));
            }
            open = { match, body: [] };
        } else if (open !== undefined) {
            open.body.push(line.replace(/^ {2}/, ""));
        }
    }
    return open === undefined ? findings : [...findings, findingOf(open.match, open.body)];
};

// A review's text, split into the prose the bubble shows and the findings the card draws. No findings is a clean review
// only where the text holds no list at all: a block this reader cannot make out stays whole in the prose instead.
export const readCodexReview = (text: string): { readonly prose: string; readonly findings?: readonly ReviewFinding[] } => {
    const header = HEADER.exec(text);
    if (header === null) {
        return text.trim() === NO_REVIEW || /^- /m.test(text) ? { prose: text } : { prose: text, findings: [] };
    }
    const findings = findingsIn(text.slice(header.index + header[0].length));
    return findings.length === 0 ? { prose: text } : { prose: text.slice(0, header.index).trim(), findings: findings.slice(0, REVIEW_FINDINGS_MAX) };
};

// The bubble's part of a review's text: the reviewer's word, the findings left to the card.
export const reviewProse = (text: string): string => readCodexReview(text).prose;

// The exitedReviewMode item ending a review, as v2's ThreadItem spells it.
const ReviewEndedSchema = z.object({ item: z.object({ type: z.literal("exitedReviewMode"), id: z.string(), review: z.string() }) });

// The card for an exitedReviewMode item that ended one of this turn's reviews; nothing for any other notification.
export const reviewFrames = (notification: AppServerNotification): CodexEvent[] => {
    const ended = notification.method === "item/completed" ? ReviewEndedSchema.safeParse(notification.params) : undefined;
    const findings = ended?.success === true ? readCodexReview(ended.data.item.review).findings : undefined;
    if (ended?.success !== true || findings === undefined) {
        return [];
    }
    return [{ type: "frame", frame: { kind: "review", review: { id: `review-${ended.data.item.id}`, source: "codex", findings: [...findings] } } }];
};
