import { readdirSync } from "node:fs";
import { join } from "node:path";
import { insideRel } from "@intentic/base/contained";
import { MEMORY_FILE, WORKSPACE_ROOT } from "@intentic/constants";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { ROSTER, subagentRunning } from "../../../conversations/actor/subagent-roster.js";
import type { FilesInFlight } from "../../../conversations/files-in-flight.js";
import { holdsChildren, recordedTargetOf } from "../../../conversations/land/land-target.js";
import { isIsolated, type PersistedAgent, worktreeOf } from "../../../conversations/registry/agents-store.js";
import { onPath } from "../../../image/on-path.js";
import { DISPATCHED_CHILD_NOTES } from "../../../runners/held-turns/dispatched-child-notes.js";
import { CHILD_NOTE_HEADER, CHILD_NOTE_TITLE } from "../../../sessions/vocabulary/prompt-envelope.js";
import { statePath } from "../../../state-paths.js";
import type { MemoryFiles } from "../../prompt/workspace-memory.js";
import { opensWithBrief } from "./child-brief.js";
import { CHILDREN } from "../child-records.js";
import type { SubagentRecord } from "../subagents.js";

/* WHAT EVERY SUBAGENT IS TOLD, SO NO PARENT WRITES IT. The shinobi-society audit (2026-11-19) read 29 spawn prompts of
   about 8.5k characters each: a report format in all 29, the repository described in 28, "never --release" in 28,
   AGENTS.md rules copied in 26, memory limits in 25, "don't commit" in 19, where artifacts go in 17, which sibling owns
   which files in 15, a hand-set `-j` in 13. The children still re-read AGENTS.md and the architecture page within their
   first 15 calls, one of them eight times. What the sandbox knows better than any parent is said here, once, as a note on
   the turn that carries the child's brief (child-brief.ts): its first turn, and every turn the sandbox starts on it again
   while no model has read the brief. A turn resuming a session that already read both does not say it twice, and the
   note never enters the brief itself, so a re-sent brief carries one. Every fact is read as the turn is planned (the
   files on the path, where its work lands, its siblings, what is installed), so the note never states something the
   sandbox has since changed. The parent's spawn tool says the sandbox does this (CHILD_BRIEF_WORDS below).

   How a child gets the workspace's AGENTS.md files, per loop: the daemon composes the ones from the root down to where the
   turn starts into every runtime's instructions (prompt/workspace-memory.ts) and switches off each loop's own reading of
   them (Claude Code's agents-md mod, claude-builtins.ts; Codex's project_doc_max_bytes, codex-instructions.ts; OpenCode
   and Pi skip project files), so "already in your instructions" is true of every loop. A repository's AGENTS.md below
   the start folder is not on that path, and is named for the child to read. Only Claude Code still loads CLAUDE.md files
   by itself, so only a Claude Code turn is told it does. */

// How many siblings the note names, and how many of each one's changed files.
const SIBLINGS_NAMED = 5;
const FILES_NAMED = 3;
const TASK_CHARS = 80;
// Folders a workspace keeps that hold no repository whose rules a child would need.
const NOT_REPOS: ReadonlySet<string> = new Set(["node_modules", "target", "dist"]);

/** What a parent's spawn tool says the sandbox gives every subagent, so the parent leaves it out of the prompt. */
export const CHILD_BRIEF_WORDS =
    "The sandbox opens its first turn with a note of its own, computed as it starts, so leave these out of the prompt: the " +
    "AGENTS.md files on its path (already in its instructions; it is told which repositories' own it must read), not to " +
    "commit and where its work lands, a folder for its artifacts, your other subagents with the files each is changing, " +
    "the build and test tools installed here (the queue sets build parallelism, so no `-j`), and the shape of its final " +
    "report (files changed, checks run with each failure placed against main, decisions taken, what is unverified). " +
    "Write the task itself: what to do, where, and how you will judge it done.";

// Where a subagent's finished work goes, as the registry reads it now (land-target.ts): into its parent's checkout, held
// for a parent that judges its children first, into the main tree its parent works in, or onto the main tree by the
// landing rules, as any conversation's.
type Landing = "parent" | "judged" | "main-tree" | "own";

/** One of the parent's other subagents, as the note names it. */
export interface SiblingFacts {
    readonly id: string;
    readonly task: string | undefined;
    readonly status: SubagentRecord["status"];
    // The siblings a pending one waits for (child-after.ts), "you" among them where it waits for this child.
    readonly after: readonly string[] | undefined;
    // Files it changed and has not landed (conversations/files-in-flight.ts).
    readonly files: readonly string[];
}

/** What the note is made of, every part read off the sandbox as the turn is planned. */
export interface ChildPreambleFacts {
    readonly childId: string;
    readonly parentId: string;
    // Instruction files already composed into the turn, and the repositories' own it was not given, workspace-relative.
    readonly memory: { readonly kept: readonly string[]; readonly notGiven: readonly string[] };
    // Claude Code's own loader reads CLAUDE.md files; no other loop here does (claude-builtins.ts, codex-instructions.ts).
    readonly claudeMd: boolean;
    readonly landing: Landing;
    readonly artifacts: string;
    readonly siblings: readonly SiblingFacts[];
    // Siblings past the ones named.
    readonly moreSiblings: number;
    // The siblings it started after (spawn's `after`, child-after.ts), whose work is in its checkout already.
    readonly after: readonly string[] | undefined;
    readonly scope?: readonly string[] | undefined;
    // What is installed of the sandbox's own build and test tools.
    readonly tools: { readonly queue: boolean; readonly quiet: boolean; readonly base: boolean; readonly digest: boolean };
}

const code = (text: string): string => `\`${text}\``;

const listed = (items: readonly string[], named = items.length): string =>
    [...items.slice(0, named).map((item) => (item === "you" ? item : code(item))), ...(items.length > named ? [`${items.length - named} more`] : [])].join(", ");

const instructionsLine = ({ memory, claudeMd }: ChildPreambleFacts): string => {
    const { kept, notGiven } = memory;
    const given = kept.length === 0 ? `No ${code(MEMORY_FILE)} is on your path.` : `${listed(kept)} ${kept.length === 1 ? "is" : "are"} already in your instructions: do not read ${kept.length === 1 ? "it" : "them"} again.`;
    const not = notGiven.length === 0 ? "" : ` Not in your instructions, so read a repository's own before you change it: ${listed(notGiven)}.`;
    const claude = claudeMd ? " Claude Code loads `CLAUDE.md` files by itself." : "";
    return `- Instructions: ${given}${not}${claude}`;
};

const LANDING_WORDS = {
    parent: "When your turn ends, the sandbox brings your changes into your parent's checkout, uncommitted; any that clash with your parent's edits wait on your branch for your parent to merge.",
    judged: "When your turn ends, your changes wait on your branch for your parent to review and merge.",
    "main-tree":
        "When your turn ends, the sandbox brings your changes into the main tree your parent works in, uncommitted; any that clash wait on your branch for your parent to merge.",
    own: "When your turn ends, your changes land in the main tree as any conversation's do, under the owner's landing rules.",
} as const satisfies Record<Landing, string>;

const siblingLine = (sibling: SiblingFacts): string => {
    const task = sibling.task === undefined ? "" : ` ("${sibling.task.slice(0, TASK_CHARS)}")`;
    const after = sibling.status === "pending" && sibling.after !== undefined && sibling.after.length > 0 ? `, starts after ${listed(sibling.after)}` : "";
    const files = sibling.files.length === 0 ? "" : `; changed, not landed: ${listed(sibling.files, FILES_NAMED)}`;
    return `  - ${code(sibling.id)}${task}: ${sibling.status}${after}${files}`;
};

const siblingLines = ({ siblings, moreSiblings }: ChildPreambleFacts): string[] =>
    siblings.length === 0
        ? ["- Siblings: none; your parent has no other subagents right now."]
        : [
              "- Siblings, your parent's other subagents, as they stood when this turn began (`agents show <id>` for now):",
              ...siblings.map(siblingLine),
              ...(moreSiblings > 0 ? [`  - and ${moreSiblings} more (\`agents ls\`)`] : []),
              "  Ask your parent before you edit a file a sibling is changing.",
          ];

const toolLines = ({ tools }: ChildPreambleFacts): string[] => {
    const lines = [
        tools.queue ? "  - The heavy-command queue sets build and test parallelism (cargo's `-j` and test threads included) and takes turns across conversations: pass no `-j` and take no turns by hand." : undefined,
        tools.quiet
            ? "  - `quiet -- <command>` for anything you time: benchmarks, profiles, steady captures. It runs one at a time sandbox-wide, each after every running build ends: build first, then time all cases in one `quiet` run."
            : undefined,
        tools.base ? "  - `base run <command>` runs a command at the commit your work started from: your before, beside your after." : undefined,
        tools.digest
            ? "  - A failing test run ends with a digest placing each failure against main: passed there, never run there, or failing there too. Report that; check one it could not place, or one it says load may explain, with `base run` before calling it yours."
            : undefined,
    ].filter((line) => line !== undefined);
    return lines.length === 0 ? [] : ["- Builds and tests:", ...lines];
};

const REPORT_LINES = [
    "- Report: your final message is what your parent reads. End it with these four parts:",
    "  1. Files changed.",
    "  2. Checks run and each one's result; for a failure, whether it is new, also fails at main, or was not checked there.",
    "  3. Decisions you took that the task left open.",
    "  4. What you did not verify.",
];

/** The note's text, from facts already read. */
export const childPreambleText = (facts: ChildPreambleFacts): string =>
    [
        CHILD_NOTE_HEADER,
        "",
        `You are ${code(facts.childId)}, a subagent of ${code(facts.parentId)}. The sandbox adds this note to every subagent's first message; your parent wrote only the task.`,
        "",
        instructionsLine(facts),
        `- Your work: do not commit or push. ${LANDING_WORDS[facts.landing]}`,
        `- Artifacts (screenshots, logs, probe scripts) go in ${code(`${facts.artifacts}/`)}, never in a repository.`,
        ...(facts.after === undefined || facts.after.length === 0
            ? []
            : [`- You started once ${listed(facts.after)} had finished: ${facts.after.length === 1 ? "its" : "their"} work is in your checkout already.`]),
        ...siblingLines(facts),
        ...(facts.scope === undefined ? [] : [`- Checkout scope: only ${listed(facts.scope)} and repository root-level files are present. Keep your changes within those folders; work outside them does not belong to this child.`]),
        ...toolLines(facts),
        ...REPORT_LINES,
    ].join("\n");

/** Where a subagent keeps what it makes while it works, beside every other conversation's artifacts. */
export const childArtifactsDir = (childId: string): string => statePath(WORKSPACE_ROOT, ".intentic/records/artifacts/", "subagents", childId);

// The repositories one folder below the root whose own instruction file the turn was not given: what a child working in
// one of them would otherwise not know it has to read. One folder deep only, where a workspace keeps its repositories.
const instructionFilesBelow = (root: string, kept: readonly string[], file: string): string[] => {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith(".") && !NOT_REPOS.has(dirent.name))
            .filter((dirent) => readdirSync(join(root, dirent.name)).includes(file))
            .map((dirent) => `${dirent.name}/${file}`)
            .filter((path) => !kept.includes(path))
            .toSorted();
    } catch {
        // allow(silent-catch): an unreadable root names no repository's file, and the note says only what it read
        return [];
    }
};

// Whether a CLAUDE.md sits on the turn's path or at a repository's top: only then is there one for Claude Code to load.
const claudeMdNear = (root: string, start: string): boolean => {
    // A start outside the root reads from the root alone, as the turn's own instructions do (workspace-memory.ts).
    const rel = insideRel(root, start) ?? "";
    const path = rel === "" ? [] : rel.split("/");
    const folders = [root, ...path.map((_, index) => join(root, ...path.slice(0, index + 1)))];
    const has = (folder: string): boolean => {
        try {
            return readdirSync(folder).includes("CLAUDE.md");
        } catch {
            // allow(silent-catch): a folder that cannot be read holds nothing the note could name
            return false;
        }
    };
    return folders.some(has) || instructionFilesBelow(root, [], "CLAUDE.md").length > 0;
};

// Its record once its checkout is composed (land-target.ts recordedTargetOf); before that, which is its first turn's
// planning, the same reading of its parent alone, for a child carrying only repositories its parent does.
const landingOf = (agents: ChildPreambleDeps["agents"], childId: string, parentId: string): Landing => {
    const parent = agents.entry(parentId);
    if (holdsChildren(parent)) {
        return "judged";
    }
    const entry = agents.entry(childId);
    if (entry !== undefined && isIsolated(entry)) {
        const target = recordedTargetOf(agents, entry);
        return target.kind === "parent" ? "parent" : target.ruled ? "own" : "main-tree";
    }
    if (parent === undefined || parent.archivedAt !== undefined) {
        return "own";
    }
    if (parent.placement.kind === "main") {
        return "main-tree";
    }
    return worktreeOf(parent)?.runner === undefined ? "parent" : "own";
};

// Live siblings first, then the ones that ended, newest first within each.
const siblingsOf = (deps: ChildPreambleDeps, childId: string, parentId: string): SiblingFacts[] =>
    deps.conversations
        .holdings(ROSTER)
        .of(parentId)
        .filter((row) => row.kind === "spawned" && row.id !== childId)
        .toSorted((left, right) => Number(subagentRunning(right)) - Number(subagentRunning(left)) || right.startedAt - left.startedAt)
        .map((row) => {
            const after = deps.conversations.holdings(CHILDREN).get(row.id)?.after?.map((id) => (id === childId ? "you" : id));
            return { id: row.id, task: row.description, status: row.status, after, files: deps.inFlight?.pathsOf(row.id) ?? [] };
        });

// The sandbox's build and test tools a shell here has, read off PATH once per daemon (image/on-path.ts caches it).
const toolsInstalled = async (outputCleaners: string): Promise<ChildPreambleFacts["tools"]> => {
    const [queue, quiet, base, filter] = await Promise.all(["queue-run", "quiet", "base", "agent-output-filter"].map((binary) => onPath(binary)));
    return { queue: queue === true, quiet: quiet === true, base: base === true, digest: filter === true && outputCleaners !== "off" };
};

/** What the note reads: the children's records and roster rows, the registry, and the files each sibling is changing. */
export interface ChildPreambleDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    readonly agents: { readonly entry: (id: string) => PersistedAgent | undefined };
    readonly inFlight?: Pick<FilesInFlight, "pathsOf"> | undefined;
    // The standing-instruction files a turn starting at `cwd` is told (agent/prompt/workspace-memory.ts), passed in by
    // the turn's plan: a value import of agent/prompt from here would close agent/subagents -> prompt -> run -> subagents.
    readonly memoryFiles: (at: { readonly root: string; readonly cwd: string }) => MemoryFiles;
}

/** The turn as its plan reads it. */
export interface ChildTurn {
    readonly conversationId: string | undefined;
    readonly prompt: string;
    // The session the turn resumes; undefined opens a fresh one, which holds nothing said before.
    readonly sessionId: string | undefined;
    // The child's checkout as the daemon reaches it, and the folder its turn starts in.
    readonly root: string;
    readonly start: string;
    // The loop running it (AgentCapabilities["runtime"]): only Claude Code loads CLAUDE.md files itself.
    readonly runtime: string;
    // The output cleaners' setting, which the test digest rides on.
    readonly outputCleaners: string;
}

/**
 * The note a spawned child's turn opens with: on a turn that carries its brief, unless the session it resumes already
 * read the brief. Undefined for every other turn. On a runner, the one its parent sent with the turn.
 */
export const childNoteFor = async (deps: ChildPreambleDeps, turn: ChildTurn): Promise<TurnNote | undefined> => {
    const childId = turn.conversationId;
    const dispatched = childId === undefined ? undefined : deps.conversations.holdings(DISPATCHED_CHILD_NOTES).get(childId);
    if (childId !== undefined && dispatched !== undefined) {
        deps.conversations.holdings(DISPATCHED_CHILD_NOTES).drop(childId);
        return dispatched;
    }
    const kid = childId === undefined ? undefined : deps.conversations.holdings(CHILDREN).get(childId);
    if (childId === undefined || kid === undefined || !opensWithBrief(kid, turn) || (kid.briefRead === true && turn.sessionId !== undefined)) {
        return undefined;
    }
    const kept = deps.memoryFiles({ root: turn.root, cwd: turn.start }).kept;
    const siblings = siblingsOf(deps, childId, kid.parent);
    const text = childPreambleText({
        childId,
        parentId: kid.parent,
        memory: { kept, notGiven: instructionFilesBelow(turn.root, kept, MEMORY_FILE) },
        claudeMd: turn.runtime === "claude-code" && claudeMdNear(turn.root, turn.start),
        landing: landingOf(deps.agents, childId, kid.parent),
        artifacts: childArtifactsDir(childId),
        siblings: siblings.slice(0, SIBLINGS_NAMED),
        moreSiblings: Math.max(0, siblings.length - SIBLINGS_NAMED),
        after: kid.after,
        scope: kid.spec.paths,
        tools: await toolsInstalled(turn.outputCleaners),
    });
    return { title: CHILD_NOTE_TITLE, text };
};
