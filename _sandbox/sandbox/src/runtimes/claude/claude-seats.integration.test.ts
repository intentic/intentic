import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { expect, test } from "vitest";
import { ensureFreshToken, fileClaudeStore } from "./claude-credentials.js";
import { fileClaudeSeatStore } from "./claude-seats.js";

/* THE SEAT AN ORGANIZATION SWITCHED OFF, and the one property that matters more than any of its behaviour:
 * nothing but this store may write it. */

const silent = pino({ level: "silent" });

const seatsIn = (dir: string) => fileClaudeSeatStore(join(dir, "seats.json"), silent);

const storeDir = (): string => mkdtempSync(join(tmpdir(), "claude-seats-"));

const REFUSAL = "Your organization has disabled Claude subscription access for Claude Code";

test("a refused seat is remembered, and clearing it puts the account back", async () => {
    const seats = seatsIn(storeDir());
    expect(await seats.read()).toEqual({});

    await seats.refuse("a", REFUSAL);
    expect((await seats.read())["a"]?.reason).toBe(REFUSAL);

    // Cleared by the turn that answers on the account, so an admin re-enabling the seat needs no reconnect.
    await seats.clear("a");
    expect(await seats.read()).toEqual({});
});

// Every turn on a benched account refuses again, and each refusal calls this. The first one is the one that
// dates the outage; a later one re-stating it must not reset the clock.
test("a second refusal keeps the timestamp the first one earned", async () => {
    const seats = seatsIn(storeDir());
    await seats.refuse("a", REFUSAL);
    const first = (await seats.read())["a"];
    await seats.refuse("a", "something else");
    expect((await seats.read())["a"]).toEqual(first);
});

test("one account's refusal says nothing about the others", async () => {
    const seats = seatsIn(storeDir());
    await seats.refuse("work", REFUSAL);
    await seats.refuse("personal", REFUSAL);
    await seats.clear("work");
    expect(Object.keys(await seats.read())).toEqual(["personal"]);
});

/* THE INCIDENT THIS FILE EXISTS FOR: the mark used to live on the account's own record, which is the one place
 * it could not survive.
 *
 * That record is a CREDENTIAL, rewritten whole every time a token rotates, and the auth dir is shared between
 * sandboxes: the writer is often another daemon, on another build, whose idea of an account has never included
 * this mark. One such rotation wrote the account back without it four hours after a seat was benched, the
 * account rejoined the rotation looking like the freest one on the list (nothing can spend on it), and the next
 * unpinned turn (a CI fix nobody was watching) went straight to it and died on the organization's refusal.
 *
 * So: rotate the token, exactly as that daemon did, and the seat must still be refused afterwards. */
test("a token rotation cannot erase a refused seat", async () => {
    const dir = storeDir();
    const [accounts, seats] = [fileClaudeStore(dir, silent), seatsIn(dir)];
    await accounts.write({ id: "a", label: "Work", connectedAt: 1, accessToken: "stale", refreshToken: "r", expiresAt: Date.now() - 1000 });
    await seats.refuse("a", REFUSAL);

    expect(await ensureFreshToken(accounts, "a", async () => ({ accessToken: "fresh" }))).toBe("fresh");
    expect((await seats.read())["a"]?.reason).toBe(REFUSAL);
});

// The same guarantee stated at the file level, because that is where it actually holds: a writer that has never
// heard of a seat refusal cannot drop one, however it rewrites the account beside it.
test("a writer that rewrites the whole account record leaves the seats file alone", async () => {
    const dir = storeDir();
    const seats = seatsIn(dir);
    await seats.refuse("a", REFUSAL);
    // Whole-record write, no read first: the shape a daemon of another vintage would produce.
    await writeFile(join(dir, "a.json"), JSON.stringify({ id: "a", label: "Work", connectedAt: 1, accessToken: "rotated" }));
    expect((await seats.read())["a"]?.reason).toBe(REFUSAL);
});

// The account store scans this directory for accounts, and a stray file it cannot parse used to surface as a
// blank row in the picker: the same hazard models.json is already held to.
test("the seats file is not mistaken for an account", async () => {
    const dir = storeDir();
    const [accounts, seats] = [fileClaudeStore(dir, silent), seatsIn(dir)];
    await accounts.write({ id: "acct-1", label: "Personal", connectedAt: 1, accessToken: "t" });
    await seats.refuse("acct-1", REFUSAL);
    expect(await accounts.list()).toEqual([{ id: "acct-1", label: "Personal", connectedAt: 1 }]);
});

test("an unreadable seats file reads as no refusals rather than failing the turn behind it", async () => {
    const dir = storeDir();
    await writeFile(join(dir, "seats.json"), `{"a":{"at":`);
    expect(await seatsIn(dir).read()).toEqual({});
    // And it is repaired by the next write rather than staying broken.
    await seatsIn(dir).refuse("a", REFUSAL);
    expect(JSON.parse(await readFile(join(dir, "seats.json"), "utf8"))).toMatchObject({ a: { reason: REFUSAL } });
});
