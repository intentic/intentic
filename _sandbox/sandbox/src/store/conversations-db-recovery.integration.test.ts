import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { sqliteAgentsStore } from "../conversations/registry/agents-store.js";
import { conversationEntry } from "../testing.js";
import { conversationUnit } from "./conversation-units.js";
import { openConversationsDbAtBoot } from "./conversations-db-recovery.js";
import { conversationsDbPath, openConversationsDb } from "./conversations-db.js";
import { clearManifestProblems, manifestProblems } from "./manifest/manifest-problems.js";

// Whatever state the conversation database is found in at boot, the daemon comes up on one, deletes nothing, and says
// what it did. Each case stands a real file up on a temp history volume.

const NOW = 1_790_000_000_000;
const errors: object[] = [];
const logger = {
    error: (fields: object): void => {
        errors.push(fields);
    },
};

beforeEach(() => {
    clearManifestProblems();
    errors.length = 0;
});
afterEach(() => clearManifestProblems());

const historyRoot = (): string => mkdtempSync(join(tmpdir(), "conversations-db-recovery-"));
const withUnit = (root: string, id: string): void => {
    mkdirSync(conversationUnit(root, id), { recursive: true });
};
const boot = (root: string, check = false) => openConversationsDbAtBoot({ historyRoot: root, check, logger, now: () => NOW });
// The whole-file problem the owner is shown, as the report names it.
const reported = (root: string) => manifestProblems(join(root, "work"), root).find((report) => report.path === `${HISTORY_ROOT}/conversations.db`)?.problems;

// A database with rows in it, closed, as a previous run left it: checkpointed, so every row is in the file itself and a
// byte changed there is not shadowed by a newer copy of its page in the log.
const populated = (root: string, ids: readonly string[]): void => {
    const db = openConversationsDb(conversationsDbPath(root));
    sqliteAgentsStore(db).save(ids.map((id) => conversationEntry({ id })));
    db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.db.close();
};

test("a first boot, with nothing on the volume, makes the database and reports nothing", () => {
    const root = historyRoot();
    const { db, recovery } = boot(root);
    expect(recovery).toBeUndefined();
    expect(sqliteAgentsStore(db).any()).toBe(false);
    expect(reported(root)).toBeUndefined();
    expect(errors).toEqual([]);
});

test("a sound database opens as it is, checked or not", () => {
    const root = historyRoot();
    populated(root, ["kept"]);
    for (const check of [false, true]) {
        const { db, recovery } = boot(root, check);
        expect(recovery).toBeUndefined();
        expect(sqliteAgentsStore(db).load().map(({ id }) => id)).toEqual(["kept"]);
        db.db.close();
    }
});

test("a database gone while conversation folders remain is made again empty, flagged, and reported", () => {
    const root = historyRoot();
    withUnit(root, "one");
    withUnit(root, "two");

    const { db, recovery } = boot(root);

    expect(recovery).toEqual({ kind: "missing", directories: 2 });
    expect(sqliteAgentsStore(db).any()).toBe(false);
    expect(reported(root)).toEqual([
        {
            kind: "unreadable",
            reason: "io",
            detail: "It was missing while 2 conversations' folders were still on the volume, so an empty one was made.",
            fix: "Their folders are kept as they are. To list those conversations again, stop the sandbox and put the missing database back.",
        },
    ]);
    expect(errors).toHaveLength(1);
});

test("a file of no bytes while conversation folders remain is a lost database too", () => {
    const root = historyRoot();
    writeFileSync(conversationsDbPath(root), "");
    withUnit(root, "one");

    const { db, recovery } = boot(root);

    expect(recovery).toEqual({ kind: "missing", directories: 1 });
    expect(sqliteAgentsStore(db).any()).toBe(false);
});

test("a file that is not a database is set aside with its sidecars, never deleted, and an empty one made", () => {
    const root = historyRoot();
    const path = conversationsDbPath(root);
    writeFileSync(path, "not a database at all, just bytes that happen to sit where one should");
    writeFileSync(`${path}-wal`, "a log of nothing");
    withUnit(root, "one");

    const { db, recovery } = boot(root);

    const aside = `${path}.corrupt-${String(NOW)}`;
    expect(recovery).toMatchObject({ kind: "replaced", aside, reason: expect.stringContaining("not a database") });
    expect(readFileSync(aside, "utf8")).toBe("not a database at all, just bytes that happen to sit where one should");
    expect(readFileSync(`${aside}-wal`, "utf8")).toBe("a log of nothing");
    expect(sqliteAgentsStore(db).any()).toBe(false);
    // Nothing of the salvage attempt is left behind beside the database.
    expect(readdirSync(root).filter((name) => name.includes("salvag"))).toEqual([]);
    expect(reported(root)).toEqual([
        {
            kind: "unreadable",
            reason: "io",
            detail: expect.stringMatching(/^It was damaged \(.*not a database.*\) and nothing could be copied out of it, so it was set aside and an empty one was made\.$/),
            fix: `The damaged file is kept at ${HISTORY_ROOT}/conversations.db.corrupt-${String(NOW)}, and every conversation's folder stays on the volume.`,
        },
    ]);
});

// Bumps the header's count of free pages past what the file holds: SQLite's quick check reports it, while every row
// still reads, which is the damage a copy can get past.
const miscountFreePages = (path: string): void => {
    const count = readFileSync(path).readUInt32BE(36);
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(count + 5);
    const fd = openSync(path, "r+");
    try {
        writeSync(fd, bytes, 0, 4, 36);
    } finally {
        closeSync(fd);
    }
};

test("damage the check finds after a run that died is set aside, and the rows that still read are copied into a new file", () => {
    const root = historyRoot();
    const path = conversationsDbPath(root);
    populated(root, ["alpha", "beta"]);
    miscountFreePages(path);
    const damaged = readFileSync(path);

    // Unchecked, the damage goes unseen: the check runs only after an unannounced death.
    const unchecked = boot(root, false);
    expect(unchecked.recovery).toBeUndefined();
    unchecked.db.db.close();

    const { db, recovery } = boot(root, true);

    const aside = `${path}.corrupt-${String(NOW)}`;
    expect(recovery).toEqual({ kind: "salvaged", aside, conversations: 2, reason: "the integrity check found damage: Freelist: size is 0 but should be 5" });
    expect(readFileSync(aside)).toEqual(damaged);
    expect(
        sqliteAgentsStore(db)
            .load()
            .map(({ id }) => id)
            .toSorted(),
    ).toEqual(["alpha", "beta"]);
    expect(db.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(reported(root)).toEqual([
        {
            kind: "unreadable",
            reason: "io",
            detail: "It was damaged (the integrity check found damage: Freelist: size is 0 but should be 5), so it was set aside and the 2 conversations that could still be read were copied into a new one.",
            fix: `The damaged file is kept at ${HISTORY_ROOT}/conversations.db.corrupt-${String(NOW)}: a conversation missing from the list may still be in it.`,
        },
    ]);
});

test("a volume that refuses even a new file leaves the daemon up on a database in memory, and says so", () => {
    const base = historyRoot();
    // A history root that is a file: nothing can be made under it.
    const root = join(base, "history");
    writeFileSync(root, "");

    const { db, recovery } = boot(root);

    expect(recovery).toMatchObject({ kind: "memory", reason: expect.any(String) });
    expect(db.path).toBe(":memory:");
    sqliteAgentsStore(db).save([conversationEntry({ id: "for-now" })]);
    expect(sqliteAgentsStore(db).any()).toBe(true);
    expect(reported(root)?.[0]?.fix).toBe("Make sure the sandbox's history volume is writable and has room, then restart the sandbox.");
});
