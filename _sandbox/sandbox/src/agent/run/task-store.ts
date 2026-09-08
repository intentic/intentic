import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { statePath } from "../../workspace/layout/state-paths.js";

// The CLI's own record of a session's checklist, read back on resume: task-checklist.ts's fold starts empty each turn,
// so an update naming last turn's task would be dropped silently. Read before the CLI starts to seed the fold with
// those ids; an unparseable file or missing directory contributes nothing.

const TASK_FILE = /^\d+\.json$/;

// What a task file says that the checklist can use, verbatim off 2.1.x: `id` is a decimal string, `subject` is what
// TaskList prints, `status` is the reducer's vocabulary. Everything else is dropped.
const StoredTaskSchema = z.object({
    id: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String),
    subject: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string().min(1).optional(),
});
export type StoredTask = z.infer<typeof StoredTaskSchema>;

// The seed a turn carries into its stream: the rows, and the session read for, so the fold adopts them only once the
// stream confirms it is that session.
export interface ChecklistSeed {
    readonly sessionId: string;
    readonly tasks: readonly StoredTask[];
}

// A session id is the store directory's name, the CLI's own UUID; anything else is refused rather than joined.
const SESSION_ID = /^[\w-]+$/;

export const taskStoreDir = (workspaceRoot: string, sessionId: string): string =>
    statePath(workspaceRoot, ".intentic/records/sessions/claude/", "tasks", sessionId);

const readTask = async (dir: string, name: string): Promise<StoredTask | undefined> => {
    try {
        const parsed = StoredTaskSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
};

// Every task in the store, in id order, the order the CLI lists them and the agent made them. A file that can't be read
// or doesn't parse is left out rather than failing the read.
export const readTaskStore = async (dir: string): Promise<StoredTask[]> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    const tasks = await Promise.all(names.filter((name) => TASK_FILE.test(name)).map((name) => readTask(dir, name)));
    return tasks.filter((task): task is StoredTask => task !== undefined).toSorted((a, b) => Number(a.id) - Number(b.id));
};

// The seed for a turn, or nothing: a first turn has no session to read, a hand-built request has no root to read it
// under, and a session that kept no list seeds nothing.
export const checklistSeedOf = async (turn: { readonly sessionId?: string; readonly workspaceRoot?: string }): Promise<ChecklistSeed | undefined> => {
    if (turn.sessionId === undefined || turn.workspaceRoot === undefined || !SESSION_ID.test(turn.sessionId)) {
        return undefined;
    }
    const tasks = await readTaskStore(taskStoreDir(turn.workspaceRoot, turn.sessionId));
    return tasks.length === 0 ? undefined : { sessionId: turn.sessionId, tasks };
};
