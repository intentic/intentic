import type { TodoItem } from "@intentic/sandbox-contract";

/* The agent's working checklist, reconstructed from the Task tool family.
 *
 * Claude Code 2.1.220 DISABLED TodoWrite: its `isEnabled()` is `!tasksEnabled() && ...`, and tasks are on
 * unless CLAUDE_CODE_ENABLE_TASKS=false — so under the Agent SDK the checklist is TaskCreate/TaskUpdate/
 * TaskList, and a TodoWrite call never arrives. There is no structured SDK message for these (the
 * SDKTask*Message family carries BACKGROUND agent tasks — subagent_type, output_file — not the checklist),
 * so the state lives only in the tool calls and their results, and this is where it gets reassembled.
 *
 * The three shapes, verbatim off the wire:
 *   TaskCreate {subject, description, activeForm?} -> "Task #1 created successfully: Gamma one"
 *   TaskUpdate {taskId, status?, subject?, activeForm?} -> "Updated task #1 status" | "Updated task #1 deleted"
 *   TaskList {} -> "#1 [pending] Gamma one\n#2 [in_progress] Delta two"   (deleted tasks omitted)
 *
 * A create only learns its id from its RESULT, so creates are applied there; an update names its id in its
 * INPUT, so those apply at call time and the list moves the instant the agent says so. TaskList is the
 * authoritative resync — it heals any drift (a resumed session whose earlier tasks this process never saw). */

const CREATED = /^Task #(\d+) created successfully/;
const LISTED = /^#(\d+) \[(pending|in_progress|completed)] (.+)$/;

type Status = TodoItem["status"];

const isStatus = (value: unknown): value is Status => value === "pending" || value === "in_progress" || value === "completed";

// The text of a tool_result block, whose content is a bare string for every Task verb (the array form carries
// tool_reference blocks, which no Task verb emits).
const resultText = (content: unknown): string | undefined => (typeof content === "string" ? content : undefined);

const stringField = (input: unknown, key: string): string | undefined => {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
};

export class TaskChecklist {
    // Insertion-ordered: the list renders in the order the agent created the tasks, which is the order it
    // intends to work them.
    private readonly tasks = new Map<string, TodoItem>();
    // TaskCreate tool_use id -> the subject/activeForm it asked for, held until its result names the task id.
    private readonly pending = new Map<string, TodoItem>();

    private snapshot(): TodoItem[] {
        return [...this.tasks.values()].map((task) => ({ ...task }));
    }

    // A TaskCreate call: remember what it asked for. Nothing to render yet — the id arrives with the result.
    created(toolUseId: string, input: unknown): void {
        const content = stringField(input, "subject");
        if (content === undefined) {
            return;
        }
        const activeForm = stringField(input, "activeForm");
        this.pending.set(toolUseId, { content, status: "pending", ...(activeForm !== undefined ? { activeForm } : {}) });
    }

    // The result of a TaskCreate: `Task #N created successfully`. Returns the updated list, or undefined when
    // this result belongs to some other tool (or a create whose subject never parsed).
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

    // A TaskUpdate call. `status: "deleted"` drops the task; every other field patches in place. An update
    // naming a task this process never saw is ignored — inventing a row from a patch would render a checklist
    // item with no subject.
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

    // The result of a TaskList: the authoritative set. Replaces everything, so tasks created before this
    // process attached (a resumed session) appear, and anything deleted elsewhere disappears.
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
            // An empty list is a real state, but so is a result this parser does not recognise; only the
            // former says "no tasks", and it is the one the harness spells exactly this way.
            return text.trim() === "" ? [] : undefined;
        }
        // TaskList does not echo activeForm, so carry the spinner label forward from what we already know.
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
