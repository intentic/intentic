import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { cleanCommitSubject, collectRepoDiff, commitMessagePrompt } from "./commit-message.js";

/* The material an AI-drafted commit message is written from. Run against REAL repos, like the rest of git/,
 * because the whole risk here is describing the wrong side: the index and the worktree disagree constantly, and
 * a fake runner would happily let a test pass while the prompt described changes the commit won't contain. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (dir: string, message: string): Promise<string> => sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A repo with two commits whose subjects establish a house style, plus .gitignore hiding .env*.
const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-commit-message-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, ".gitignore"), ".env*\n");
    await writeFile(join(dir, "a.txt"), "one\n");
    await sh(dir, "add", "-A");
    await commit(dir, "feat: add a.txt");
    await writeFile(join(dir, "b.txt"), "b\n");
    await sh(dir, "add", "-A");
    await commit(dir, "fix: add b.txt");
    return dir;
};

test("describes the INDEX for an ordinary commit — the unstaged edit beside it is not what git will record", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "staged\n");
    await sh(dir, "add", "a.txt");
    await writeFile(join(dir, "b.txt"), "not part of this commit\n");

    const diff = await collectRepoDiff("root", dir, false);

    expect(diff.summary).toContain("a.txt");
    expect(diff.patch).toContain("staged");
    // The failure this prevents: a confident subject line about work the user deliberately left out.
    expect(diff.patch).not.toContain("not part of this commit");
});

test("describes the WORKTREE for Commit all, new files included — `git add -A` sweeps them, so the message must too", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited in place\n");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, true);

    expect(diff.patch).toContain("edited in place");
    // `git diff HEAD` cannot see an untracked file at all, so a commit that is ENTIRELY new files would
    // otherwise reach the model as an empty diff — the most common case there is.
    expect(diff.summary).toContain("fresh.txt");
    expect(diff.patch).toContain("brand new content");
});

test("leaves ignored files out of the Commit all draft, exactly as `git add -A` would", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, ".env"), "SECRET=leaked\n");
    await writeFile(join(dir, "a.txt"), "edited\n");

    const diff = await collectRepoDiff("root", dir, true);

    expect(diff.patch).not.toContain("SECRET=leaked");
});

test("reads no untracked files for a staged commit — they are not in the index", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "staged\n");
    await sh(dir, "add", "a.txt");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, false);

    expect(diff.patch).not.toContain("brand new content");
});

test("carries the repo's own recent subjects, newest first — the house style is inferred, never prescribed", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const diff = await collectRepoDiff("root", dir, false);

    expect(diff.subjects).toEqual(["fix: add b.txt", "feat: add a.txt"]);
    expect(commitMessagePrompt([diff])).toContain("fix: add b.txt");
});

test("survives an unborn repo instead of failing the whole draft", async () => {
    // Every git command here exits non-zero with no HEAD. The other repos in a multi-repo commit still describe
    // themselves, so this repo contributing nothing is the right outcome — not a 500.
    const dir = await mkdtemp(join(tmpdir(), "intentic-commit-message-"));
    tempDirs.push(dir);
    await sh(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "one\n");

    const diff = await collectRepoDiff("root", dir, true);

    expect(diff.subjects).toEqual([]);
    expect(diff.patch).toContain("a.txt");
});

test("names every repo and says the message is shared when a commit spans more than one", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");
    const one = await collectRepoDiff("root", dir, false);
    const two = { ...one, repo: "widgets" };

    const prompt = commitMessagePrompt([one, two]);

    expect(prompt).toContain("## Repository: root");
    expect(prompt).toContain("## Repository: widgets");
    expect(prompt).toContain("spans 2 repositories");
    expect(commitMessagePrompt([one])).not.toContain("spans");
});

test("marks a clipped diff as clipped, so a truncated hunk does not read as the whole change", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), `${"line of content\n".repeat(20_000)}`);
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, false)]);

    expect(prompt).toContain("diff truncated");
    // The file list is assembled before the budget is applied, so it survives whole — the model still knows
    // every path that moved even when it cannot read every line.
    expect(prompt).toContain("big.txt");
});

test("unwraps the packaging a cheap model adds even when told not to", () => {
    expect(cleanCommitSubject("feat: add autofill")).toBe("feat: add autofill");
    expect(cleanCommitSubject("```\nfeat: add autofill\n```")).toBe("feat: add autofill");
    expect(cleanCommitSubject("```text\nfeat: add autofill\n```")).toBe("feat: add autofill");
    expect(cleanCommitSubject(`"feat: add autofill"`)).toBe("feat: add autofill");
    expect(cleanCommitSubject("Subject: feat: add autofill")).toBe("feat: add autofill");
    expect(cleanCommitSubject("- feat: add autofill")).toBe("feat: add autofill");
    expect(cleanCommitSubject("   \n\nfeat: add autofill\n")).toBe("feat: add autofill");
});

test("keeps only the first line — the commit box is single-line, so a body has nowhere to go", () => {
    expect(cleanCommitSubject("feat: add autofill\n\nDrafts the message from the staged diff.")).toBe("feat: add autofill");
});

test("leaves quotes that are part of the subject alone", () => {
    // Only a SYMMETRIC surrounding pair is packaging; an apostrophe or a quoted term is the message itself.
    expect(cleanCommitSubject(`fix: don't drop the "all" flag`)).toBe(`fix: don't drop the "all" flag`);
});

test("reports an empty answer as empty, so the caller can say the model said nothing", () => {
    expect(cleanCommitSubject("")).toBe("");
    expect(cleanCommitSubject("   \n\n  ")).toBe("");
    expect(cleanCommitSubject("```\n```")).toBe("");
});
