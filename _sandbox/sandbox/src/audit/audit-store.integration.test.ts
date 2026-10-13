import { mkdtempSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, AuditRecord } from "@intentic/sandbox-contract";
import { GENESIS_HASH, sealRecord } from "./audit-chain.js";
import { fileAuditLog } from "./audit-store.js";

const root = (): string => mkdtempSync(join(tmpdir(), "audit-"));
const segmentsDir = (historyRoot: string): string => join(historyRoot, "audit", "segments");
const failOnWarn = (message: string, error: Error): never => {
    throw new Error(`${message}: ${error.message}`);
};

const owner = { kind: "member", email: "owner@example.com", role: "owner" } as const;
const event = (action: string): AuditEvent => ({ actor: owner, action });
const eventOn = (action: string, target: string): AuditEvent => ({ actor: owner, action, target });

// Writes a chain of records at the given times straight into their month files, as an older build would have.
const seed = async (historyRoot: string, times: readonly number[]): Promise<AuditRecord[]> => {
    await mkdir(segmentsDir(historyRoot), { recursive: true });
    const records: AuditRecord[] = [];
    let previous = GENESIS_HASH;
    for (const [index, at] of times.entries()) {
        const record = sealRecord({ v: 1, id: `seed-${index}`, at, actor: owner, action: "member.grant", prevHash: previous });
        await appendFile(join(segmentsDir(historyRoot), `${new Date(at).toISOString().slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`);
        records.push(record);
        previous = record.hash;
    }
    return records;
};

test("records are chained on disk, listed newest first with filters and a cursor, and verify whole", async () => {
    const historyRoot = root();
    const log = fileAuditLog(historyRoot, failOnWarn);
    log.record(event("settings.change"));
    log.record(eventOn("member.grant", "ann@example.com"));
    log.record({ actor: { kind: "system", reason: "retention" }, action: "audit.pruned" });
    await log.flush();

    const all = await log.list({ limit: 10 });
    expect(all.records.map((record) => record.action)).toEqual(["audit.pruned", "member.grant", "settings.change"]);
    expect(all.records[2]?.prevHash).toBe(GENESIS_HASH);
    expect(all.records[1]?.prevHash).toBe(all.records[2]?.hash);

    expect((await log.list({ limit: 10, action: "member." })).records.map((record) => record.target)).toEqual(["ann@example.com"]);
    expect((await log.list({ limit: 10, actor: "OWNER@" })).records).toHaveLength(2);
    const first = await log.list({ limit: 2 });
    expect(first.records).toHaveLength(2);
    const second = await log.list({ limit: 2, before: first.next });
    expect(second.records).toEqual(all.records.slice(2));
    expect(second.next).toBeUndefined();

    expect(await log.verify()).toEqual({ ok: true, checked: 3, segments: 1, torn: false });
});

test("a line changed on disk is found by verify, which names it", async () => {
    const historyRoot = root();
    const log = fileAuditLog(historyRoot, failOnWarn);
    log.record(eventOn("member.grant", "ann@example.com"));
    log.record(eventOn("member.remove", "bob@example.com"));
    await log.flush();
    const [segment = ""] = await readdir(segmentsDir(historyRoot));
    const path = join(segmentsDir(historyRoot), segment);
    await writeFile(path, (await readFile(path, "utf8")).replace("bob@example.com", "eve@example.com"));
    expect(await log.verify()).toMatchObject({ ok: false, broken: { segment, line: 2, reason: "hash-mismatch" } });
});

test("a torn last line is cut off before the next write, and the cut is itself recorded", async () => {
    const historyRoot = root();
    const log = fileAuditLog(historyRoot, failOnWarn);
    log.record(event("settings.change"));
    await log.flush();
    const [segment = ""] = await readdir(segmentsDir(historyRoot));
    await appendFile(join(segmentsDir(historyRoot), segment), '{"v":1,"id":"torn');
    expect((await fileAuditLog(historyRoot, failOnWarn).verify()).torn).toBe(true);

    const reopened = fileAuditLog(historyRoot, failOnWarn);
    reopened.record(event("member.grant"));
    await reopened.flush();
    expect((await reopened.list({ limit: 10 })).records.map((record) => record.action)).toEqual([
        "member.grant",
        "audit.torn_write_dropped",
        "settings.change",
    ]);
    expect(await reopened.verify()).toMatchObject({ ok: true, checked: 3, torn: false });
});

test("retention deletes whole months past the limit, and the chain still verifies from the checkpoint", async () => {
    const historyRoot = root();
    const now = Date.UTC(2026, 9, 13);
    const seeded = await seed(historyRoot, [Date.UTC(2025, 6, 2), Date.UTC(2025, 6, 20), Date.UTC(2026, 7, 1), Date.UTC(2026, 9, 1)]);
    const log = fileAuditLog(historyRoot, failOnWarn);

    expect(await log.prune(365, now)).toEqual(["2025-07.jsonl"]);
    expect(await log.segments()).toEqual(["2026-08.jsonl", "2026-10.jsonl"]);
    expect(await log.verify()).toEqual({
        ok: true,
        checked: 2,
        segments: 2,
        torn: false,
        prunedThrough: { at: seeded[1]?.at ?? 0, hash: seeded[1]?.hash ?? "missing" },
    });
    // The current month is never pruned, however short the retention.
    expect(await log.prune(30, now)).toEqual(["2026-08.jsonl"]);
    expect(await log.segments()).toEqual(["2026-10.jsonl"]);

    // A new record links onto the last one kept, and the chain still checks out.
    log.record(event("settings.change"));
    await log.flush();
    expect((await log.list({ limit: 1 })).records[0]?.prevHash).toBe(seeded[3]?.hash);
    expect(await log.verify()).toMatchObject({ ok: true, checked: 2 });
});

test("an export holds the period's lines exactly as stored, oldest first", async () => {
    const historyRoot = root();
    const seeded = await seed(historyRoot, [Date.UTC(2026, 7, 30), Date.UTC(2026, 8, 2), Date.UTC(2026, 8, 29), Date.UTC(2026, 9, 1)]);
    const log = fileAuditLog(historyRoot, failOnWarn);
    const exported = await log.exportRange(Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1));
    expect(exported.count).toBe(2);
    expect(exported.filename).toBe("audit-2026-09-01-to-2026-09-30.jsonl");
    expect(exported.jsonl).toBe(`${JSON.stringify(seeded[1])}\n${JSON.stringify(seeded[2])}\n`);
});
