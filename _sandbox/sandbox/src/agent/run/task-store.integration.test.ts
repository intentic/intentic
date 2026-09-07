import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checklistSeedOf, readTaskStore, taskStoreDir } from "./task-store.js";

const SESSION = "6e296ad0-8660-428e-aa79-b014a3c61004";

// A store the way the CLI leaves one: one file per task, ids as decimal strings, its lock file beside them.
const storeAt = (root: string, sessionId: string, files: Record<string, string>): string => {
    const dir = taskStoreDir(root, sessionId);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content);
    }
    return dir;
};

// Verbatim shape off a 2.1.x task file, the fields the reader drops included.
const task = (id: number, subject: string, status: string, activeForm?: string): string =>
    JSON.stringify({
        id: String(id),
        subject,
        description: `${subject}, at length`,
        status,
        blocks: [],
        blockedBy: [],
        ...(activeForm === undefined ? {} : { activeForm }),
    });

test("reads every task in id order, ignoring the lock and anything that is not a task", async () => {
    const root = mkdtempSync(join(tmpdir(), "task-store-"));
    const dir = storeAt(root, SESSION, {
        "10.json": task(10, "Tenth", "pending"),
        "2.json": task(2, "Second", "in_progress", "Doing the second"),
        "1.json": task(1, "First", "completed"),
        ".lock": "",
        "notes.txt": "not a task",
        // A write in flight, and a shape from some other version: each contributes nothing, neither fails the read.
        "3.json": "{ not json",
        "4.json": JSON.stringify({ id: "4", subject: "Another version's row", status: "done" }),
    });
    expect(await readTaskStore(dir)).toEqual([
        { id: "1", subject: "First", status: "completed" },
        { id: "2", subject: "Second", status: "in_progress", activeForm: "Doing the second" },
        { id: "10", subject: "Tenth", status: "pending" },
    ]);
});

test("a store that is not there is an empty list, not a failure", async () => {
    expect(await readTaskStore(join(tmpdir(), "task-store-never", "tasks", SESSION))).toEqual([]);
});

test("the seed names the session it was read for, and is nothing for a first turn or an empty store", async () => {
    const root = mkdtempSync(join(tmpdir(), "task-store-"));
    storeAt(root, SESSION, { "1.json": task(1, "First", "completed") });
    expect(await checklistSeedOf({ sessionId: SESSION, workspaceRoot: root })).toEqual({
        sessionId: SESSION,
        tasks: [{ id: "1", subject: "First", status: "completed" }],
    });
    // A first turn has no session; a hand-built request has no root; a session that kept no list has no store.
    expect(await checklistSeedOf({ workspaceRoot: root })).toBeUndefined();
    expect(await checklistSeedOf({ sessionId: SESSION })).toBeUndefined();
    expect(await checklistSeedOf({ sessionId: "0000-never-kept-a-list", workspaceRoot: root })).toBeUndefined();
    // A session id is a directory name; one that is not a bare name is refused rather than joined into a path.
    expect(await checklistSeedOf({ sessionId: "../../etc", workspaceRoot: root })).toBeUndefined();
});
