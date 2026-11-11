import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { INJECTED, LITERAL_SLASH_NOTE_HEADER, WORKTREE_NOTE_HEADER } from "../../sessions/vocabulary/prompt-envelope.js";

// TurnNote is canonical and becomes wire text once, in composeWirePrompt; the parser half reads a stored prompt back.

// Shared with session recall, which cuts the same preamble off transcripts it indexes.
const SEPARATOR = TURN_PREAMBLE_SEPARATOR;

export const LITERAL_SLASH_NOTE: TurnNote = {
    title: "How to read this message",
    text:
        `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
        "It opens with `/` but names no slash command available here: the leading token is the user's own words " +
        "(a route, a path, a filename). Read the whole message as ordinary prose.",
};

// For runtimes with no isolation mechanism (Codex app-server, ACP: only cwd'd into their worktree), an absolute /work
// path lands in the SHARED checkout — this note is the only guard. Said in full once per session; later turns get only
// the short reminder.
export const WORKTREE_NOTE_TITLE = "Where this turn's files live";

export const worktreeNote = (worktree: string, root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n` +
        `This conversation works on its own git branch, checked out at \`${worktree}\`, and this runtime reaches ` +
        `it by working directory alone, so \`${root}\` is still the SHARED checkout every other agent is editing. ` +
        `Use relative paths, or absolute paths under \`${worktree}\`. An absolute \`${root}/…\` path (from a memory, ` +
        `an AGENTS.md, or an earlier turn) writes outside your branch, where the work is neither reviewed nor landed.`,
});

export const worktreeReminder = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text: `${WORKTREE_NOTE_HEADER}\n\nUse relative paths. \`${root}\` is the shared checkout, not this branch.`,
});

// A fenced conversation's sandbox (conversations/worktrees/turn-sandbox.ts) holds only its areas and no git history.
// Said once per session, because an agent that meets `git` failing or a folder missing spends calls looking for a way
// round both; same header as the note above, which is what this is about and what session recall already cuts at.
export const fencedNote = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n` +
        `This conversation is limited to some areas of the workspace, and it runs in a sandbox holding only those: ` +
        `\`${root}\` is its own checkout cut to them, and nothing else of the workspace is on this filesystem. The ` +
        `checkout has no git history, so \`git\` finds no repository here: the sandbox records your changes on the ` +
        `conversation's branch by itself, so edit the files and leave committing to it. A folder that is absent is ` +
        `outside this conversation's areas; say so rather than looking for it elsewhere.`,
});

export const fencedReminder = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text: `${WORKTREE_NOTE_HEADER}\n\n\`${root}\` holds only this conversation's areas, and it has no git; your changes are recorded for you.`,
});

// The whole-workspace jail private conversations put every turn in (turn-sandbox.ts WholeJail), for a turn in its own
// worktree: git works, but the shared checkout and every other conversation's are off this filesystem. Said once per
// session, because jailed agents (2026-11-11) pruned and repaired the worktree records they saw as dangling, switched a
// conversation's checkout to main, and edited their own checkout believing it the shared one.
export const jailedNote = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n` +
        `\`${root}\` here is this conversation's own checkout, on its own branch (\`agent/<conversation id>\`), not the ` +
        `shared workspace other people and agents use, which this turn cannot see. Other conversations' checkouts are not ` +
        `on this filesystem, so git lists them as prunable: never run \`git worktree prune\`, \`repair\`, \`move\` or ` +
        `\`remove\`, which would break them. Never switch this checkout to the workspace's main line either: its work ` +
        `reaches main by landing. If a land says the workspace is off its main line, tell the person to press Back to ` +
        `main in the Changes view rather than fixing it with git.`,
});

export const jailedReminder = (root: string): TurnNote => ({
    title: WORKTREE_NOTE_TITLE,
    text:
        `${WORKTREE_NOTE_HEADER}\n\n\`${root}\` is this conversation's own checkout, not the shared workspace: never prune, ` +
        `repair, move or remove git worktrees, nor switch it to the main line.`,
});

// Deliberately no note: the model reliably over-reacted to being told about a routine rebase, re-verifying builds
// unprompted. The human still sees it in the `worktree` frame; a rebase that doesn't apply is caught at land time
// (conversations/land.ts) instead of by prose.

// Notes go in front of the message, separated exactly once no matter how many passes add to them: merging, not nesting,
// since the parser anchors on the FIRST separator and a nested second one would leak through as the user's own words.
export const withTurnPreamble = (notes: readonly string[], prompt: string): string => {
    if (notes.length === 0) {
        return prompt;
    }
    const joined = notes.join("\n\n");
    return INJECTED.some(({ header }) => prompt.startsWith(header)) ? `${joined}\n\n${prompt}` : `${joined}${SEPARATOR}${prompt}`;
};

// The one place TurnNote[] becomes the wire string, right before a request leaves for its adapter (agent.routes.ts);
// everything upstream carries typed notes. The composed form exists only on the wire and in the provider's own session
// store.
export const composeWirePrompt = (notes: readonly TurnNote[], prompt: string): string =>
    withTurnPreamble(
        notes.map((note) => note.text),
        prompt,
    );
