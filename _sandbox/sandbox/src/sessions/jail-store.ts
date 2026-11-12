import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { isConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { statePath } from "../state-paths.js";
import { FROZEN, thawClaudeSession } from "./session-freeze.js";
import { jailStoreDir, SESSION_STATE, type StoreOwner } from "./session-store.js";

/* A CONVERSATION'S SESSIONS FOLLOW IT INTO THE JAIL AND OUT AGAIN (2026-11-04). While conversations can be private, every
   turn runs in the jail (conversations/worktrees/turn-sandbox.ts WholeJail), and the shared session store, which holds
   every unfenced conversation's Claude sessions, is out of its reach: the turn's runtime writes a store of the
   conversation's own instead (session-store.ts jailStoreDir). So before a conversation's first jailed turn its current
   session moves there, for the turn to resume, and once nothing is private any longer everything it holds moves back,
   for the next turn, which runs unjailed over the shared store again. A move is made whole aside and renamed into place,
   so every daemon reader (claudeStoreOf) finds a session in one store or the other, never half of it. A fenced
   conversation keeps its own store for life and is never moved. */

export type JailStoreOwner = StoreOwner & { readonly sessionId?: string | undefined };

// A session id is the CLI's own UUID; anything else is refused rather than joined into a path.
const SESSION_ID = /^[\w-]+$/u;

const sharedStore = (workspaceRoot: string): string => statePath(workspaceRoot, ".intentic/records/sessions/claude/");

const exists = async (path: string): Promise<boolean> => (await stat(path).catch(undefinedIfMissing)) !== undefined;

const namesIn = async (dir: string): Promise<string[]> => (await readdir(dir).catch(undefinedIfMissing)) ?? [];

// What one session keeps in a store, store-relative: its transcript (and a compressed copy a thaw left beside it,
// session-freeze.ts) and the directory beside it (subagents, tool output) under whichever project the CLI filed it, its
// checklists, its task list and its environment snapshot.
export const sessionPaths = async (store: string, sessionId: string): Promise<string[]> => {
    if (!SESSION_ID.test(sessionId)) {
        return [];
    }
    const found: string[] = [];
    for (const project of await namesIn(join(store, "projects"))) {
        for (const name of [`${sessionId}.jsonl`, `${sessionId}.jsonl${FROZEN}`, sessionId]) {
            found.push(join("projects", project, name));
        }
    }
    found.push(...(await namesIn(join(store, "todos"))).filter((name) => name.startsWith(sessionId)).map((name) => join("todos", name)));
    found.push(join("tasks", sessionId), join("session-env", sessionId));
    const present = await Promise.all(found.map(async (rel) => ((await exists(join(store, rel))) ? rel : undefined)));
    return present.filter((rel) => rel !== undefined);
};

const movable = (owner: JailStoreOwner): boolean => owner.identity.areas === undefined && isConversationId(owner.id);

/** Before a jailed turn: the conversation's current session out of the shared store into its own, once. */
export const enterJailStore = async (workspaceRoot: string, historyRoot: string, owner: JailStoreOwner): Promise<string> => {
    const store = jailStoreDir(historyRoot, owner.id);
    if (!movable(owner) || (await exists(store))) {
        return store;
    }
    const shared = sharedStore(workspaceRoot);
    const staging = `${store}.part`;
    await rm(staging, { recursive: true, force: true });
    for (const name of SESSION_STATE) {
        await mkdir(join(staging, name), { recursive: true });
    }
    // Plain before it moves, if the cold-session sweep compressed it: the jailed turn is about to resume it.
    if (owner.sessionId !== undefined) {
        await thawClaudeSession(shared, owner.sessionId);
    }
    const moved = owner.sessionId === undefined ? [] : await sessionPaths(shared, owner.sessionId);
    for (const rel of moved) {
        await cp(join(shared, rel), join(staging, rel), { recursive: true });
    }
    await rename(staging, store);
    // Only once the store stands: a crash before this leaves a second copy in the shared store, never none.
    await Promise.all(moved.map((rel) => rm(join(shared, rel), { recursive: true, force: true })));
    return store;
};

/** Before an unjailed turn: everything the conversation's own store holds back into the shared one, then the store gone. */
export const leaveJailStore = async (workspaceRoot: string, historyRoot: string, owner: JailStoreOwner): Promise<void> => {
    if (!movable(owner)) {
        return;
    }
    const store = jailStoreDir(historyRoot, owner.id);
    if (!(await exists(store))) {
        return;
    }
    const shared = sharedStore(workspaceRoot);
    for (const name of SESSION_STATE) {
        if (await exists(join(store, name))) {
            // Never over a file another conversation keeps there: only names no session owns (a plan) could meet one.
            await cp(join(store, name), join(shared, name), { recursive: true, force: false, errorOnExist: false });
        }
    }
    // Set aside first, so readers switch to the shared store at one rename and never read a store half removed.
    const aside = `${store}.gone`;
    await rm(aside, { recursive: true, force: true });
    await rename(store, aside);
    await rm(aside, { recursive: true, force: true });
};
