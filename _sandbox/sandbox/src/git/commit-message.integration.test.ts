import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { cleanCommitMessage, cleanCommitSubject, cleanReleaseNote, collectRepoDiff, commitMessagePrompt } from "./commit-message.js";

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

    const diff = await collectRepoDiff("root", dir, {});

    expect(diff.summary).toContain("a.txt");
    expect(diff.patch).toContain("staged");
    // The failure this prevents: a confident subject line about work the user deliberately left out.
    expect(diff.patch).not.toContain("not part of this commit");
});

test("describes the WORKTREE for Commit all, new files included — `git add -A` sweeps them, so the message must too", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited in place\n");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, { all: true });

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

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(diff.patch).not.toContain("SECRET=leaked");
});

test("describes ONLY the paths a filtered commit will stage — the worktree beside them is another agent's work", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "the filtered agent's edit\n");
    await writeFile(join(dir, "b.txt"), "somebody else's edit\n");
    await writeFile(join(dir, "mine.txt"), "an untracked file inside the subset\n");
    await writeFile(join(dir, "theirs.txt"), "an untracked file outside it\n");

    const diff = await collectRepoDiff("root", dir, { paths: ["a.txt", "mine.txt"] });

    expect(diff.patch).toContain("the filtered agent's edit");
    // The whole point of the shape: this commit stages a subset, so a message describing the rest would be
    // confidently about changes it is not going to record.
    expect(diff.patch).not.toContain("somebody else's edit");
    // Untracked files are listed and read from disk rather than diffed, so they need the SAME narrowing —
    // separately, and this is the assertion that catches it going missing.
    expect(diff.summary).toContain("mine.txt");
    expect(diff.patch).toContain("an untracked file inside the subset");
    expect(diff.summary).not.toContain("theirs.txt");
});

test("keeps the diff flags out of the pathspec — `--` ends the option list, so `--stat` after it is a filename", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited\n");

    const diff = await collectRepoDiff("root", dir, { paths: ["a.txt"] });

    // A misordered `diff HEAD -- a.txt --stat` exits non-zero, and tryGit swallows that into an empty string —
    // so the failure mode is a silently blank summary, not an error anyone would see.
    expect(diff.summary).toContain("a.txt");
    expect(diff.summary).toContain("M\ta.txt");
});

test("reads no untracked files for a staged commit — they are not in the index", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "staged\n");
    await sh(dir, "add", "a.txt");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, {});

    expect(diff.patch).not.toContain("brand new content");
});

test("carries the repo's own recent subjects, newest first — the house style is inferred, never prescribed", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const diff = await collectRepoDiff("root", dir, {});

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

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(diff.subjects).toEqual([]);
    expect(diff.patch).toContain("a.txt");
});

test("names every repo and says the message is shared when a commit spans more than one", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");
    const one = await collectRepoDiff("root", dir, {});
    const two = { ...one, repo: "widgets" };

    const prompt = commitMessagePrompt([one, two]);

    expect(prompt).toContain("## Repository: root");
    expect(prompt).toContain("## Repository: widgets");
    expect(prompt).toContain("spans 2 repositories");
    expect(commitMessagePrompt([one])).not.toContain("spans");
});

test("carries the session's ask as context to be overruled, and says nothing about one when there is none", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");
    const diff = await collectRepoDiff("root", dir, {});

    const prompt = commitMessagePrompt([diff], "Review panel · audit");

    expect(prompt).toContain(`tasked with "Review panel · audit"`);
    // The half that matters: the ask is the thing most likely to be STALE — a session that audited and then
    // fixed still answers to "audit" — so the prompt has to say the diff wins, or the model writes the title back.
    expect(prompt).toContain("if the diff shows something else, describe the diff");
    expect(commitMessagePrompt([diff])).not.toContain("tasked with");
});

test("marks a clipped diff as clipped, so a truncated hunk does not read as the whole change", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), `${"line of content\n".repeat(20_000)}`);
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

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

test("takes the subject alone — the body is the other reader's job (cleanCommitMessage)", () => {
    expect(cleanCommitSubject("feat: add autofill\n\nDrafts the message from the staged diff.")).toBe("feat: add autofill");
});

test("asks for a release note only when the repo keeps a changelog", () => {
    const noNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", patch: "" }]);
    expect(noNote).not.toContain("Release-Note:");
    expect(noNote.trimEnd().endsWith("Reply with the subject line only.")).toBe(true);

    const wantsNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", patch: "" }], undefined, true);
    expect(wantsNote).toContain("Release-Note: <one plain sentence>");
    // The omission instruction is the load-bearing half: most commits change nothing a user would notice, and a
    // model that writes a note for every one of them refills the changelog with the noise it exists to remove.
    expect(wantsNote).toContain("OMIT the Release-Note line entirely");
});

test("reads the note off the reply, and says so when there isn't one", () => {
    expect(cleanReleaseNote("feat: ordered model picker\n\nRelease-Note: Your models stay in the order you set them.")).toBe(
        "Your models stay in the order you set them.",
    );
    // The common case by far: the model judged the change invisible from outside and left the line out.
    expect(cleanReleaseNote("refactor: split the picker component")).toBe("");
    // Packaging comes off a note exactly as it comes off a subject.
    expect(cleanReleaseNote('feat: x\n\nRelease-Note: "Your models stay put."')).toBe("Your models stay put.");
    // A model that leads with the note has still answered correctly, in the other order.
    expect(cleanReleaseNote("Release-Note: Your models stay put.\nfeat: ordered model picker")).toBe("Your models stay put.");
});

test("a note-first reply still yields the subject, not the note", () => {
    expect(cleanCommitSubject("Release-Note: Your models stay put.\nfeat: ordered model picker")).toBe("feat: ordered model picker");
});

test("composes subject and note as a git trailer, and the subject alone without one", () => {
    // The blank line is what makes it a trailer rather than the second line of the subject's paragraph.
    expect(cleanCommitMessage("feat: ordered model picker\nRelease-Note: Your models stay put.")).toBe(
        "feat: ordered model picker\n\nRelease-Note: Your models stay put.",
    );
    // No note ⇒ byte for byte what the box received before any of this existed.
    expect(cleanCommitMessage("refactor: split the picker component")).toBe("refactor: split the picker component");
    // Nothing at all is still nothing — the caller reports the model said nothing rather than committing a trailer.
    expect(cleanCommitMessage("Release-Note: orphaned note")).toBe("");
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
