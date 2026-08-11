import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
    cleanBreakingNote,
    cleanCommitSubject,
    cleanReleaseNote,
    collectRepoDiff,
    commitMessagePrompt,
    MAX_NOTE_LENGTH,
    type RepoDiff,
} from "./commit-message.js";

/* The material an AI-drafted commit message is written from. Run against REAL repos, like the rest of git/,
 * because the whole risk here is describing the wrong side: the index and the worktree disagree constantly, and
 * a fake runner would happily let a test pass while the prompt described changes the commit won't contain. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (dir: string, message: string): Promise<string> => sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);

// The patch as one string again, for the assertions that only care THAT a hunk was collected. The per-file
// split is asserted on its own below, where it is the thing under test rather than plumbing.
const patchOf = (diff: RepoDiff): string => diff.blocks.map((block) => block.text).join("\n");

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
    expect(patchOf(diff)).toContain("staged");
    // The failure this prevents: a confident subject line about work the user deliberately left out.
    expect(patchOf(diff)).not.toContain("not part of this commit");
});

test("describes the WORKTREE for Commit all, new files included — `git add -A` sweeps them, so the message must too", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited in place\n");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(patchOf(diff)).toContain("edited in place");
    // `git diff HEAD` cannot see an untracked file at all, so a commit that is ENTIRELY new files would
    // otherwise reach the model as an empty diff — the most common case there is.
    expect(diff.summary).toContain("fresh.txt");
    expect(patchOf(diff)).toContain("brand new content");
});

test("leaves ignored files out of the Commit all draft, exactly as `git add -A` would", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, ".env"), "SECRET=leaked\n");
    await writeFile(join(dir, "a.txt"), "edited\n");

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(patchOf(diff)).not.toContain("SECRET=leaked");
});

test("describes ONLY the paths a filtered commit will stage — the worktree beside them is another agent's work", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "the filtered agent's edit\n");
    await writeFile(join(dir, "b.txt"), "somebody else's edit\n");
    await writeFile(join(dir, "mine.txt"), "an untracked file inside the subset\n");
    await writeFile(join(dir, "theirs.txt"), "an untracked file outside it\n");

    const diff = await collectRepoDiff("root", dir, { paths: ["a.txt", "mine.txt"] });

    expect(patchOf(diff)).toContain("the filtered agent's edit");
    // The whole point of the shape: this commit stages a subset, so a message describing the rest would be
    // confidently about changes it is not going to record.
    expect(patchOf(diff)).not.toContain("somebody else's edit");
    // Untracked files are listed and read from disk rather than diffed, so they need the SAME narrowing —
    // separately, and this is the assertion that catches it going missing.
    expect(diff.summary).toContain("mine.txt");
    expect(patchOf(diff)).toContain("an untracked file inside the subset");
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

    expect(patchOf(diff)).not.toContain("brand new content");
});

test("cuts the patch into one block per file, named by where the file ENDED", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited\n");
    await writeFile(join(dir, "b.txt"), "also edited\n");
    await sh(dir, "add", "-A");

    const diff = await collectRepoDiff("root", dir, {});

    // The split is what lets the budget be spent per file instead of on whatever git happened to emit first.
    expect(diff.blocks.map((block) => block.path).toSorted()).toEqual(["a.txt", "b.txt"]);
    expect(diff.blocks.find((block) => block.path === "a.txt")?.text).toContain("edited");
});

test("carries the repo's own recent subjects, newest first — its vocabulary, even though the type is dictated", async () => {
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
    expect(patchOf(diff)).toContain("a.txt");
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

test("prescribes the Conventional Commits type and demands real identifiers", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    // The type is the one convention this file imposes rather than infers — a repo with a messy log used to get
    // its mess faithfully reproduced.
    expect(prompt).toContain("feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert");
    // The instruction that makes the history searchable: without it the cheap rung writes "improve error
    // handling", which matches nothing anyone would ever look for.
    expect(prompt).toContain("NAME THINGS");
    // And the instruction that keeps it cheap to read back.
    expect(prompt).toContain("Never list the files that changed");
});

test("tells nothing about the session that asked for the work — the diff is the only witness", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    /* The regression this pins. The prompt used to carry the session's title as context "to be overruled by the
     * diff", and the cheap rung wrote it back as the answer instead — so a conversation named for the question
     * that opened it committed under that question. Worse, the title is model-written: a naming pass that failed
     * and asked for more context put its own request into the commit message. */
    expect(prompt).not.toContain("tasked with");
    expect(prompt.toLowerCase()).not.toContain("session");
});

test("spends the budget per file, so a small meaningful change survives a huge one beside it", async () => {
    const dir = await tempRepo();
    // Alphabetically first, and far larger than the whole prompt's allowance — under one shared clip it ate
    // every file after it, and the model confidently described the least interesting change in the commit.
    await writeFile(join(dir, "aaa-huge.txt"), `${"line of noise\n".repeat(20_000)}`);
    await writeFile(join(dir, "zzz-small.txt"), "the change this commit is actually about\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    expect(prompt).toContain("the change this commit is actually about");
    // The big one is still there, still clipped, and still says so — a hunk that stops with no marker reads as
    // a complete edit that simply ends.
    expect(prompt).toContain("line of noise");
    expect(prompt).toContain("truncated");
});

test("names generated files without spending the budget on them", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "package-lock.json"), `{"lockfileVersion":3,"packages":{${'"x":{"resolved":"noise"},'.repeat(400)}}}\n`);
    await writeFile(join(dir, "src.txt"), "the reason for the lockfile change\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    // A lockfile records THAT dependencies moved; the file beside it records why, in four lines.
    expect(prompt).toContain("package-lock.json: generated file");
    expect(prompt).not.toContain(`"resolved":"noise"`);
    expect(prompt).toContain("the reason for the lockfile change");
});

test("marks a clipped diff as clipped, so a truncated hunk does not read as the whole change", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "big.txt"), `${"line of content\n".repeat(20_000)}`);
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    expect(prompt).toContain("truncated");
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

test("skips a preamble to the line that is actually the message", () => {
    // The failure this prevents is a commit whose subject is "Here's the commit message:" — the cheap rung
    // ignores "no preamble" often enough that anchoring on the type prefix is the only reliable start.
    const reply = "Sure! Here's the commit message:\nfix: stop the picker reordering on refresh\n\n- drops the sort in resolveQuickModels";
    expect(cleanCommitSubject(reply)).toBe("fix: stop the picker reordering on refresh");
});

test("a model that writes a body anyway has it dropped, not filed", () => {
    // The prompt asks for one line; this is what happens when the cheap rung answers with the shape it has seen
    // ten thousand times instead. There is no body reader to hold those lines, so they fall on the floor — the
    // subject is what the box gets, and a model ignoring the format cannot lengthen a commit message by it.
    const reply = ["feat: name sessions from the opening prompt", "", "- adds nameAgentTitle", "- rejects a reply that asks a question"].join("\n");
    expect(cleanCommitSubject(reply)).toBe("feat: name sessions from the opening prompt");
});

test("asks for one line and no body at all", () => {
    const prompt = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    expect(prompt).toContain("ONE LINE ONLY");
    // The format block must not show a body line either: a shape shown is a shape written, whatever the rules
    // underneath it say.
    expect(prompt).not.toContain("one fact per line");
    expect(prompt).not.toContain("body lines");
});

test("asks for a release note only when the repo keeps a changelog", () => {
    const noNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    expect(noNote).not.toContain("Release-Note:");

    const wantsNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], true);
    expect(wantsNote).toContain("Release-Note: <one plain sentence>");
    // The length the store will cut at, stated in the ask rather than only enforced after it: a model that does
    // not know the ceiling writes past it, and a sentence cut mid-word reaches the changelog and the update card.
    expect(wantsNote).toContain(`at most ${MAX_NOTE_LENGTH} characters`);
    // The omission instruction is the load-bearing half: most commits change nothing a user would notice, and a
    // model that writes a note for every one of them refills the changelog with the noise it exists to remove.
    expect(wantsNote).toContain("OMIT the Release-Note line entirely");
    // The breaking note rides the same gate: no changelog, no breaking sentence either.
    expect(noNote).not.toContain("Breaking-Note:");
    expect(wantsNote).toContain("Breaking-Note:");
    // …and the instruction ties the sentence to the "!" type marker the release tooling majors on.
    expect(wantsNote).toContain(`mark the type with "!"`);
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

test("reads the breaking sentence off the reply, apart from the note", () => {
    const reply =
        "feat!: retire the legacy picker\n\nRelease-Note: The model picker is simpler now.\nBreaking-Note: The old picker layout is gone — use the new list.";
    expect(cleanBreakingNote(reply)).toBe("The old picker layout is gone — use the new list.");
    // Each cleaner reads only its own trailer, whichever order the model wrote them in.
    expect(cleanReleaseNote(reply)).toBe("The model picker is simpler now.");
    // The overwhelmingly common case: nothing was taken away, no line was written.
    expect(cleanBreakingNote("feat: ordered model picker\n\nRelease-Note: Your models stay put.")).toBe("");
    // A breaking line never leaks into the subject, same as the note.
    expect(cleanCommitSubject("Breaking-Note: The old picker is gone.\nfeat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
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
