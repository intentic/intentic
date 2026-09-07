import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { statePath } from "../../workspace/layout/state-paths.js";

/* THE CLI'S OWN RECORD OF A SESSION'S CHECKLIST, read back for the turn that resumes the session.
 *
 * task-checklist.ts rebuilds the list from the Task verbs as they go past, and a TaskUpdate names only an id:
 * a row the fold has never seen is ignored rather than invented. Every row IS seen on the turn that creates
 * it. On the next turn of the same conversation the fold starts empty, so an update to a task made last turn
 * is dropped on the floor, silently, and the list the daemon holds stops moving while the CLI's own keeps
 * going. That is how a conversation that finished all nine of its steps across a usage-limit resume wore an
 * "Unfinished, 6 of 9" mark for it: the resumed turn completed six tasks by TaskUpdate, none of them applied
 * here, and the finish carried the previous turn's count forward (agents-registry's unfinishedOf, whose carry
 * rule is right and was reading a list nothing had moved). A TaskList would have healed it, and nothing had
 * told the agent to call one.
 *
 * The CLI writes every task down as it goes, one JSON file per task under `tasks/<session id>/` in the state
 * the daemon links onto the workspace (sessions/session-store.ts), and that file is the row the update names.
 * Read before the CLI starts, it seeds the fold with exactly the ids this turn's updates will carry. Nothing is
 * asked of the model, nothing waits on a TaskList, and the finish measures the list as it stands rather than as
 * it stood the last time a turn happened to look.
 *
 * The layout is the CLI's own and undocumented, like the result strings the reducer parses, and it is read
 * with the same posture: a file that does not parse or a shape this does not recognise contributes nothing, a
 * directory that is not there is an empty list, and a session that kept no checklist seeds nothing. Only
 * `<n>.json` is a task; the `.lock` beside them is not. */

const TASK_FILE = /^\d+\.json$/;

// What a task file says that the checklist can use. Verbatim off 2.1.x: `id` is a decimal string, `subject` is
// what TaskList prints, `status` is the reducer's own vocabulary. Everything else on the file (description,
// blocks, blockedBy, owner, metadata) is the CLI's business and is dropped.
const StoredTaskSchema = z.object({
    id: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String),
    subject: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string().min(1).optional(),
});
export type StoredTask = z.infer<typeof StoredTaskSchema>;

// The seed a turn carries into its stream: the rows, and the session they were read for, so the fold adopts
// them only once the stream confirms it is running that session (sdk-stream's adoptChecklist says why).
export interface ChecklistSeed {
    readonly sessionId: string;
    readonly tasks: readonly StoredTask[];
}

// A session id is the store directory's name and only ever the CLI's own UUID; anything else is refused
// rather than joined into a path.
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

/* Every task in the store, in id order, which is the order the CLI lists them and the order the agent made
 * them. A file that cannot be read or does not parse (a write in flight, a shape from another version) is left
 * out rather than failing the read: a seed short one row is worth more than no seed. */
export const readTaskStore = async (dir: string): Promise<StoredTask[]> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    const tasks = await Promise.all(names.filter((name) => TASK_FILE.test(name)).map((name) => readTask(dir, name)));
    return tasks.filter((task): task is StoredTask => task !== undefined).toSorted((a, b) => Number(a.id) - Number(b.id));
};

// The seed for a turn, or nothing: a first turn has no session to read, a hand-built request has no root to
// read it under (agent.ts's `workspaceRoot`), and a session that kept no list seeds nothing.
export const checklistSeedOf = async (turn: { readonly sessionId?: string; readonly workspaceRoot?: string }): Promise<ChecklistSeed | undefined> => {
    if (turn.sessionId === undefined || turn.workspaceRoot === undefined || !SESSION_ID.test(turn.sessionId)) {
        return undefined;
    }
    const tasks = await readTaskStore(taskStoreDir(turn.workspaceRoot, turn.sessionId));
    return tasks.length === 0 ? undefined : { sessionId: turn.sessionId, tasks };
};
