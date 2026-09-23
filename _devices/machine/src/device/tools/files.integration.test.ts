import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentHome } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { afterAll, expect, test } from "bun:test";
import { ScopeError } from "../policy.js";
import { editTextFile, readTextFile, trashFile, writeTextFile } from "./files.js";

// The file tools on a real temp tree, as the POSIX user running the suite: every file is written here, and the one
// allowed root is `root`. A sibling outside it is what the links try to reach.

const base = realpathSync(mkdtempSync(join(tmpdir(), "device-files-")));
const root = join(base, "allowed");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);

const grant: DeviceScopes = { shell: "off", write: "on", screen: "off", control: "off", sandboxes: "off", destructive: "off", roots: root };

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

let named = 0;
// A fresh path per test, so no test reads another's file.
const fresh = (name: string): string => {
    named += 1;
    const dir = join(root, `case-${named}`);
    mkdirSync(dir);
    return join(dir, name);
};

const revisionOf = (note: string): string => /Revision ([0-9a-f]{16})\b/.exec(note)?.[1] ?? "";

const revisionOfFile = async (path: string): Promise<string> => revisionOf((await readTextFile(path, {}, grant)).note);

test("a read answers with the text, and beside it a revision that follows the bytes", async () => {
    const path = fresh("notes.txt");
    writeFileSync(path, "one\ntwo\n");
    const first = await readTextFile(path, {}, grant);
    expect(first.text).toBe("one\ntwo\n");
    expect(first.note).toMatch(/^All 2 lines\. Revision [0-9a-f]{16}: write_file and edit_file need it to change this file\.$/);
    writeFileSync(path, "one\nTWO\n");
    expect(await revisionOfFile(path)).not.toBe(revisionOf(first.note));
    // The same bytes again are the same revision: it names the content, not the moment it was written.
    writeFileSync(path, "one\ntwo\n");
    expect(await revisionOfFile(path)).toBe(revisionOf(first.note));
});

test("a ranged read gives those lines and says where to continue", async () => {
    const path = fresh("ten.txt");
    writeFileSync(path, Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    const middle = await readTextFile(path, { offset: 3, limit: 4 }, grant);
    expect(middle.text).toBe("line 3\nline 4\nline 5\nline 6");
    expect(middle.note).toMatch(/^Lines 3-6 of 10\. 4 more after these: continue with offset 7\. Revision /);
    const rest = await readTextFile(path, { offset: 7 }, grant);
    expect(rest.text).toBe("line 7\nline 8\nline 9\nline 10");
    expect(rest.note).toMatch(/^Lines 7-10 of 10\. Revision /);
    await expect(readTextFile(path, { offset: 11 }, grant)).rejects.toThrow(`"${path}" has 10 lines, so there is nothing from line 11 on.`);
});

// 21,000 lines of 100 characters with their newlines: 2,100,000, past the 2,000,000 one answer holds.
test("a file longer than one answer is refused whole, and a range of it stops at the last line that fits", async () => {
    const path = fresh("long.txt");
    writeFileSync(path, `${"x".repeat(99)}\n`.repeat(21_000));
    await expect(readTextFile(path, {}, grant)).rejects.toThrow(`"${path}" is 21000 lines, more than one read answers with: read it in parts with offset and limit.`);
    const first = await readTextFile(path, { offset: 1 }, grant);
    expect(first.note).toMatch(/^Lines 1-20000 of 21000\. 1000 more after these: continue with offset 20001\. /);
    expect(first.text.length).toBe(20_000 * 100 - 1);
});

test("a binary file is refused rather than read as text", async () => {
    const path = fresh("image.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
    await expect(readTextFile(path, {}, grant)).rejects.toThrow(`"${path}" is not a text file: it has NUL bytes, which text does not.`);
});

// Windows-1252 "Größe": readable enough to look at, and a write-back would turn ö and ß into replacement characters.
test("text in a legacy code page is read with its bad bytes replaced, and is never written back", async () => {
    const path = fresh("legacy.txt");
    const bytes = Buffer.from([0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a]);
    writeFileSync(path, bytes);
    const read = await readTextFile(path, {}, grant);
    expect(read.text).toBe("Gr\uFFFD\uFFFDe\n");
    expect(read.note).toContain("Not UTF-8 or UTF-16 text (a legacy code page, most likely)");
    await expect(writeTextFile(path, "Size\n", revisionOf(read.note), grant)).rejects.toThrow("is not UTF-8 or UTF-16 text");
    expect(readFileSync(path)).toEqual(bytes);
});

test("replacing a file takes the revision of a read, and one the file has moved past is refused", async () => {
    const path = fresh("config.json");
    expect(await writeTextFile(path, "{}", undefined, grant)).toMatch(new RegExp(`^Created ${path} \\(2 characters\\)\\. Revision [0-9a-f]{16}\\.$`));
    await expect(writeTextFile(path, `{"a":1}`, undefined, grant)).rejects.toThrow("already exists. Read it first");
    const read = await revisionOfFile(path);
    // Somebody else changes it between our read and our write.
    writeFileSync(path, `{"theirs":true}`);
    await expect(writeTextFile(path, `{"a":1}`, read, grant)).rejects.toThrow(`"${path}" has changed since you read it (you read revision ${read}`);
    expect(readFileSync(path, "utf8")).toBe(`{"theirs":true}`);
    const written = await writeTextFile(path, `{"a":1}`, await revisionOfFile(path), grant);
    expect(written).toMatch(new RegExp(`^Overwrote ${path} \\(7 characters\\)\\. Revision [0-9a-f]{16}\\.$`));
    expect(readFileSync(path, "utf8")).toBe(`{"a":1}`);
    // The revision a write answers with is the file's own, good for the next change without another read.
    expect(revisionOf(written)).toBe(await revisionOfFile(path));
});

test("a revision for a file that has gone is refused rather than recreating it", async () => {
    const path = fresh("gone.txt");
    await expect(writeTextFile(path, "back", "0123456789abcdef", grant)).rejects.toThrow("no longer exists");
    expect(() => statSync(path)).toThrow();
});

test("a CRLF file keeps CRLF, whatever line endings the text arrives with", async () => {
    const path = fresh("crlf.txt");
    writeFileSync(path, "a\r\nb\r\n");
    const read = await readTextFile(path, {}, grant);
    expect(read.text).toBe("a\nb\n");
    expect(read.note).toContain("Saved with CRLF line endings (shown here as LF), which a write keeps.");
    const written = await writeTextFile(path, "a\nb\nc\n", revisionOf(read.note), grant);
    expect(written).toContain("saved with CRLF line endings as before");
    expect(readFileSync(path, "utf8")).toBe("a\r\nb\r\nc\r\n");
    await editTextFile(path, { oldString: "b\nc", newString: "B\r\nC", revision: revisionOf(written) }, grant);
    expect(readFileSync(path, "utf8")).toBe("a\r\nB\r\nC\r\n");
});

// Windows PowerShell 5.1's `>` and Out-File write UTF-16LE with a BOM and CRLF.
test("a UTF-16LE file keeps its encoding, its BOM and its line endings", async () => {
    const path = fresh("powershell.txt");
    writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\r\n", "utf16le")]));
    const read = await readTextFile(path, {}, grant);
    expect(read.text).toBe("héllo\n");
    expect(read.note).toContain("Saved as UTF-16LE with BOM and with CRLF line endings");
    await writeTextFile(path, "héllo wörld\n", revisionOf(read.note), grant);
    expect(readFileSync(path)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo wörld\r\n", "utf16le")]));
});

test("a UTF-8 file with a BOM keeps exactly one", async () => {
    const path = fresh("bom.txt");
    writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0a]));
    const read = await readTextFile(path, {}, grant);
    expect(read.text).toBe("x\n");
    // Sent with a BOM of its own, as text copied from somewhere may be.
    await writeTextFile(path, "\uFEFFy\n", revisionOf(read.note), grant);
    expect(readFileSync(path)).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x79, 0x0a]));
});

test("a write replaces the file whole, so a reader holding the old one still has it, and keeps the file's mode", async () => {
    const path = fresh("run.sh");
    writeFileSync(path, "echo old\n");
    chmodSync(path, 0o754);
    const held = openSync(path, "r");
    try {
        await writeTextFile(path, "echo new\n", await revisionOfFile(path), grant);
        expect(readFileSync(held, "utf8")).toBe("echo old\n");
    } finally {
        closeSync(held);
    }
    expect(readFileSync(path, "utf8")).toBe("echo new\n");
    expect(statSync(path).mode & 0o7777).toBe(0o754);
    // Nothing staged is left beside it.
    expect(readdirSync(dirname(path))).toEqual(["run.sh"]);
});

test("a read-only file is left read-only and unchanged", async () => {
    const path = fresh("locked.txt");
    writeFileSync(path, "keep\n");
    chmodSync(path, 0o444);
    await expect(writeTextFile(path, "lose\n", await revisionOfFile(path), grant)).rejects.toThrow(`"${path}" is read-only`);
    expect(readFileSync(path, "utf8")).toBe("keep\n");
});

test("an edit replaces its one match, taken literally, and answers with a revision the next edit can use", async () => {
    const path = fresh("list.md");
    writeFileSync(path, "alpha\nbeta\ngamma\n");
    const first = await editTextFile(path, { oldString: "beta", newString: "$& and $1", revision: await revisionOfFile(path) }, grant);
    expect(first).toMatch(new RegExp(`^Edited ${path}\\. Revision [0-9a-f]{16}\\.$`));
    await editTextFile(path, { oldString: "gamma", newString: "GAMMA", revision: revisionOf(first) }, grant);
    expect(readFileSync(path, "utf8")).toBe("alpha\n$& and $1\nGAMMA\n");
});

test("an edit is refused when its text is missing, ambiguous, unchanged, stale, or has no file", async () => {
    const path = fresh("twice.txt");
    writeFileSync(path, "same\nsame\n");
    const revision = await revisionOfFile(path);
    await expect(editTextFile(path, { oldString: "absent", newString: "x", revision }, grant)).rejects.toThrow(`old_string is not in "${path}"`);
    await expect(editTextFile(path, { oldString: "same", newString: "x", revision }, grant)).rejects.toThrow(`old_string matches more than one place in "${path}"`);
    await expect(editTextFile(path, { oldString: "same", newString: "same", revision }, grant)).rejects.toThrow("there is nothing to change");
    await expect(editTextFile(path, { oldString: "same\nsame", newString: "x", revision: "0123456789abcdef" }, grant)).rejects.toThrow("has changed since you read it");
    await expect(editTextFile(`${path}.missing`, { oldString: "a", newString: "b", revision }, grant)).rejects.toThrow("does not exist: create it with write_file");
    expect(readFileSync(path, "utf8")).toBe("same\nsame\n");
});

test("a link out of the allowed folder is refused for reading and for writing, and what it points at is untouched", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "not yours\n");
    const link = fresh("secret-link");
    symlinkSync(secret, link);
    await expect(readTextFile(link, {}, grant)).rejects.toThrow(ScopeError);
    await expect(writeTextFile(link, "mine\n", "0123456789abcdef", grant)).rejects.toThrow(ScopeError);
    const folderLink = fresh("outside-link");
    symlinkSync(outside, folderLink);
    await expect(writeTextFile(join(folderLink, "planted.txt"), "x", undefined, grant)).rejects.toThrow(ScopeError);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    expect(readFileSync(secret, "utf8")).toBe("not yours\n");
});

test("a link that stays inside is written through to its file, and stays a link", async () => {
    const real = fresh("real.txt");
    writeFileSync(real, "before\n");
    const link = join(dirname(real), "alias.txt");
    symlinkSync(real, link);
    await writeTextFile(link, "after\n", await revisionOfFile(link), grant);
    expect(readFileSync(real, "utf8")).toBe("after\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

// The trash is under the agent's home, and a rename cannot cross filesystems: this tree has to share one with it.
test("trashing a link moves the link, not what it points at", async () => {
    const home = agentHome("machine").dir;
    mkdirSync(home, { recursive: true });
    const dir = mkdtempSync(join(home, "test-trash-link-"));
    const target = join(dir, "target.txt");
    writeFileSync(target, "stays\n");
    symlinkSync(target, join(dir, "link.txt"));
    const said = await trashFile(join(dir, "link.txt"), { ...grant, roots: dir });
    const moved = /to (.+?)\. It is recoverable/.exec(said)?.[1] ?? "";
    try {
        expect(lstatSync(moved).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("stays\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(dirname(moved), { recursive: true, force: true });
    }
});
