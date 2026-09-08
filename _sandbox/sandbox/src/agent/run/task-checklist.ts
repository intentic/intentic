import type { TodoItem } from "@intentic/sandbox-contract";
import type { StoredTask } from "./task-store.js";

// The agent's working checklist, rebuilt from the Task tool family (TaskCreate/TaskUpdate/TaskList), since no SDK
// message carries it. A create learns its id from its result; an update names its id in its input and applies
// immediately; TaskList is the authoritative resync, and a resumed session's tasks arrive via `seed` first.

const CREATED = /^Task #(\d+) created successfully/;
const LISTED = /^#(\d+) \[(pending|in_progress|completed)] (.+)$/;

type Status = TodoItem["status"];

const isStatus = (value: unknown): value is Status => value === "pending" || value === "in_progress" || value === "completed";

// The text of a tool_result block, a bare string for every Task verb (the array form carries tool_reference blocks,
// which no Task verb emits).
const resultText = (content: unknown): string | undefined => (typeof content === "string" ? content : undefined);

const stringField = (input: unknown, key: string): string | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
};

export class TaskChecklist {
    // Insertion-ordered: the list renders in the order the agent created the tasks.
    private readonly tasks = new Map<string, TodoItem>();
    // TaskCreate tool_use id -> the subject/activeForm it asked for, held until its result names the task id.
    private readonly pending = new Map<string, TodoItem>();

    // A fresh array, but the items are shared: every mutation REPLACES a task rather than patching it in place, so an
    // already-emitted list can't change under the UI.
    private snapshot(): TodoItem[] {
        return [...this.tasks.values()];
    }

    // A TaskCreate call: remember what it asked for. Nothing to render yet, the id arrives with the result.
    created(toolUseId: string, input: unknown): void {
        const content = stringField(input, "subject");
        if (content === undefined) {
            return;
        }
        const activeForm = stringField(input, "activeForm");
        this.pending.set(toolUseId, { content, status: "pending", ...(activeForm !== undefined ? { activeForm } : {}) });
    }

    // The result of a TaskCreate: `Task #N created successfully`. Undefined when this result belongs to another tool,
    // or a create whose subject never parsed.
    resolved(toolUseId: string, content: unknown): TodoItem[] | undefined {
        const task = this.pending.get(toolUseId);
        if (task === undefined) {
            return undefined;
        }
        this.pending.delete(toolUseId);
        const id = CREATED.exec(resultText(content) ?? "")?.[1];
        if (id === undefined) {
            return undefined;
        }
        this.tasks.set(id, task);
        return this.snapshot();
    }

    // A TaskUpdate call. `status: "deleted"` drops the task; every other field patches in place. An update naming an
    // unseen task is ignored rather than inventing a row with no subject.
    updated(input: unknown): TodoItem[] | undefined {
        const id = stringField(input, "taskId");
        if (id === undefined) {
            return undefined;
        }
        const status = (input as { status?: unknown }).status;
        if (status === "deleted") {
            return this.tasks.delete(id) ? this.snapshot() : undefined;
        }
        const task = this.tasks.get(id);
        if (task === undefined) {
            return undefined;
        }
        const activeForm = stringField(input, "activeForm") ?? task.activeForm;
        this.tasks.set(id, {
            content: stringField(input, "subject") ?? task.content,
            status: isStatus(status) ? status : task.status,
            ...(activeForm !== undefined ? { activeForm } : {}),
        });
        return this.snapshot();
    }

    // The rows a resumed session already holds (task-store.ts). Replaces everything, like `listed`, since it is the
    // authoritative set as of turn start.
    seed(rows: readonly StoredTask[]): TodoItem[] | undefined {
        if (rows.length === 0) {
            return undefined;
        }
        this.tasks.clear();
        for (const row of rows) {
            this.tasks.set(row.id, {
                content: row.subject,
                status: row.status,
                ...(row.activeForm !== undefined ? { activeForm: row.activeForm } : {}),
            });
        }
        return this.snapshot();
    }

    // The result of a TaskList: the authoritative set. Replaces everything, so tasks created before this process
    // attached appear, and anything deleted elsewhere disappears.
    listed(content: unknown): TodoItem[] | undefined {
        const text = resultText(content);
        if (text === undefined) {
            return undefined;
        }
        const rows = text
            .split("\n")
            .map((line) => LISTED.exec(line.trim()))
            .filter((match) => match !== null);
        if (rows.length === 0) {
            // An empty list is real, but so is an unrecognised result; only the former says "no tasks", spelled this
            // way.
            return text.trim() === "" ? [] : undefined;
        }
        // TaskList does not echo activeForm, so carry the spinner label forward from what is already known.
        const known = new Map(this.tasks);
        this.tasks.clear();
        for (const row of rows) {
            const [, id, status, subject] = row as unknown as [string, string, Status, string];
            const activeForm = known.get(id)?.activeForm;
            this.tasks.set(id, { content: subject, status, ...(activeForm !== undefined ? { activeForm } : {}) });
        }
        return this.snapshot();
    }
}
