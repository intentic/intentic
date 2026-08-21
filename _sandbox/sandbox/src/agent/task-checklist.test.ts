import { expect, test } from "vitest";
import { TaskChecklist } from "./task-checklist.js";

// Every result string here is verbatim from a live 2.1.220 turn: the parser has no other contract.
const create = (list: TaskChecklist, toolUseId: string, subject: string, id: string, activeForm?: string) => {
    list.created(toolUseId, { subject, description: subject, ...(activeForm !== undefined ? { activeForm } : {}) });
    return list.resolved(toolUseId, `Task #${id} created successfully: ${subject}`);
};

test("a create renders only once its result names the task id", () => {
    const list = new TaskChecklist();
    list.created("t1", { subject: "Gamma one", description: "Gamma one", activeForm: "Doing gamma" });
    expect(list.resolved("t2", "Task #9 created successfully: other")).toBeUndefined();
    expect(list.resolved("t1", "Task #1 created successfully: Gamma one")).toEqual([
        { content: "Gamma one", status: "pending", activeForm: "Doing gamma" },
    ]);
});

test("creates keep the order the agent asked for them in", () => {
    const list = new TaskChecklist();
    create(list, "t1", "First", "1");
    create(list, "t2", "Second", "2");
    expect(create(list, "t3", "Third", "3")?.map((task) => task.content)).toEqual(["First", "Second", "Third"]);
});

test("an update patches status in place and leaves the rest alone", () => {
    const list = new TaskChecklist();
    create(list, "t1", "Gamma one", "1", "Doing gamma");
    expect(list.updated({ taskId: "1", status: "in_progress" })).toEqual([
        { content: "Gamma one", status: "in_progress", activeForm: "Doing gamma" },
    ]);
});

test("an update can rewrite the subject and spinner label", () => {
    const list = new TaskChecklist();
    create(list, "t1", "Gamma one", "1");
    expect(list.updated({ taskId: "1", subject: "Gamma renamed", activeForm: "Renaming" })).toEqual([
        { content: "Gamma renamed", status: "pending", activeForm: "Renaming" },
    ]);
});

test("status deleted drops the task", () => {
    const list = new TaskChecklist();
    create(list, "t1", "Keep", "1");
    create(list, "t2", "Drop", "2");
    expect(list.updated({ taskId: "2", status: "deleted" })).toEqual([{ content: "Keep", status: "pending" }]);
});

test("an update for a task this process never saw is ignored", () => {
    const list = new TaskChecklist();
    expect(list.updated({ taskId: "7", status: "completed" })).toBeUndefined();
    expect(list.updated({ taskId: "7", status: "deleted" })).toBeUndefined();
});

test("TaskList is authoritative: it adopts tasks created before we attached", () => {
    const list = new TaskChecklist();
    expect(list.listed("#1 [completed] Gamma one\n#2 [in_progress] Delta two")).toEqual([
        { content: "Gamma one", status: "completed" },
        { content: "Delta two", status: "in_progress" },
    ]);
});

test("a resync carries the spinner label forward, since TaskList omits it", () => {
    const list = new TaskChecklist();
    create(list, "t1", "Gamma one", "1", "Doing gamma");
    expect(list.listed("#1 [in_progress] Gamma one")).toEqual([{ content: "Gamma one", status: "in_progress", activeForm: "Doing gamma" }]);
});

test("an empty TaskList clears the checklist; an unparseable result leaves it alone", () => {
    const list = new TaskChecklist();
    create(list, "t1", "Gamma one", "1");
    expect(list.listed("Some other tool's output")).toBeUndefined();
    expect(list.listed("")).toEqual([]);
});

test("a create whose result did not parse renders nothing rather than a task with no id", () => {
    const list = new TaskChecklist();
    list.created("t1", { subject: "Gamma one", description: "Gamma one" });
    expect(list.resolved("t1", "Task creation failed")).toBeUndefined();
    expect(list.updated({ taskId: "1", status: "completed" })).toBeUndefined();
});
