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
    fallbackBreakingNote,
    markSubjectBreaking,
    MAX_NOTE_LENGTH,
    MAX_SUBJECT_LENGTH,
    parsableMessage,
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

test("describes the INDEX for an ordinary commit: the unstaged edit beside it is not what git will record", async () => {
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

test("describes the WORKTREE for Commit all, new files included: `git add -A` sweeps them, so the message must too", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited in place\n");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(patchOf(diff)).toContain("edited in place");
    // `git diff HEAD` cannot see an untracked file at all, so a commit that is ENTIRELY new files would
    // otherwise reach the model as an empty diff: the most common case there is.
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

test("describes ONLY the paths a filtered commit will stage: the worktree beside them is another agent's work", async () => {
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
    // Untracked files are listed and read from disk rather than diffed, so they need the SAME narrowing:
    // separately, and this is the assertion that catches it going missing.
    expect(diff.summary).toContain("mine.txt");
    expect(patchOf(diff)).toContain("an untracked file inside the subset");
    expect(diff.summary).not.toContain("theirs.txt");
});

test("keeps the diff flags out of the pathspec: `--` ends the option list, so `--stat` after it is a filename", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited\n");

    const diff = await collectRepoDiff("root", dir, { paths: ["a.txt"] });

    // A misordered `diff HEAD -- a.txt --stat` exits non-zero, and tryGit swallows that into an empty string:
    // so the failure mode is a silently blank summary, not an error anyone would see.
    expect(diff.summary).toContain("a.txt");
    expect(diff.summary).toContain("M\ta.txt");
});

test("reads no untracked files for a staged commit: they are not in the index", async () => {
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

test("carries the repo's own recent subjects, newest first: its vocabulary, even though the type is dictated", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const diff = await collectRepoDiff("root", dir, {});

    expect(diff.subjects).toEqual(["fix: add b.txt", "feat: add a.txt"]);
    expect(commitMessagePrompt([diff])).toContain("fix: add b.txt");
});

test("survives an unborn repo instead of failing the whole draft", async () => {
    // Every git command here exits non-zero with no HEAD. The other repos in a multi-repo commit still describe
    // themselves, so this repo contributing nothing is the right outcome, not a 500.
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

    expect(prompt).toContain(`## Repository: ${one.repo}`);
    expect(prompt).toContain(`## Repository: ${two.repo}`);
    expect(prompt.match(/## Repository:/g)?.length).toBe(2);
    expect(commitMessagePrompt([one]).match(/## Repository:/g)?.length).toBe(1);
});

test("prescribes the Conventional Commits type and demands real identifiers", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    // The type is the one convention this file imposes rather than infers: a repo with a messy log used to get
    // its mess faithfully reproduced.
    expect(prompt).toContain("feat");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("revert");
    // The instruction that makes the history searchable: without it the cheap rung writes "improve error
    // handling", which matches nothing anyone would ever look for.
    expect(prompt).toContain("NAME THINGS");
    // And the instruction that keeps it cheap to read back.
    expect(prompt).toContain("files that changed");
});

test("tells nothing about the session that asked for the work: the diff is the only witness", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    /* The regression this pins. The prompt used to carry the session's title as context "to be overruled by the
     * diff", and the cheap rung wrote it back as the answer instead, so a conversation named for the question
     * that opened it committed under that question. Worse, the title is model-written: a naming pass that failed
     * and asked for more context put its own request into the commit message. */
    expect(prompt).not.toContain("tasked with");
    expect(prompt.toLowerCase()).not.toContain("session");
});

test("spends the budget per file, so a small meaningful change survives a huge one beside it", async () => {
    const dir = await tempRepo();
    // Alphabetically first, and far larger than the whole prompt's allowance: under one shared clip it ate
    // every file after it, and the model confidently described the least interesting change in the commit.
    await writeFile(join(dir, "aaa-huge.txt"), `${"line of noise\n".repeat(20_000)}`);
    await writeFile(join(dir, "zzz-small.txt"), "the change this commit is actually about\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    expect(prompt).toContain("the change this commit is actually about");
    // The big one is still there, still clipped, and still says so: a hunk that stops with no marker reads as
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
    // The file list is assembled before the budget is applied, so it survives whole: the model still knows
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

/* THE REFUSALS THE CHEAP RUNG EARNS, AND THE ONES IT NO LONGER DOES. Each case below is a real commit-msg
 * rejection that reached the user as a red box under a message that was otherwise the one they wanted, which is
 * the entire cost of drafting these on a cheap model. Asserted as a group because the rule they answer to is a
 * group: a message routinely breaks two at once (a capitalised subject that ends in a full stop). */
test("repairs the mechanical rules a commit-msg hook refuses, and leaves the sentence alone", () => {
    // A leading capital on an ordinary word: lowered, which is what the prompt asked for and costs nothing.
    expect(cleanCommitSubject("feat(ui): Redesign the sandbox access view")).toBe("feat(ui): redesign the sandbox access view");
    // A trailing period, and both spellings of it.
    expect(cleanCommitSubject("fix: stop the picker reordering.")).toBe("fix: stop the picker reordering");
    expect(cleanCommitSubject("fix: stop the picker reordering...")).toBe("fix: stop the picker reordering");
    // A capitalised type, and a colon the model spaced oddly.
    expect(cleanCommitSubject("Feat:  add autofill")).toBe("feat: add autofill");
    // A shout has no identifier spelling left to protect, so it is lowered whole rather than by its first letter.
    expect(cleanCommitSubject("fix: STOP THE PICKER REORDERING")).toBe("fix: stop the picker reordering");
    // Nothing wrong ⇒ nothing touched, including a name in the middle of the line, where the case rule never
    // looked. This is the common reply and the repair must be invisible on it.
    expect(cleanCommitSubject("feat(access): show StatusBadge on the member roster")).toBe("feat(access): show StatusBadge on the member roster");
});

test("a breaking marker written ahead of the scope is moved rather than left for the hook to refuse", () => {
    /* THE REFUSAL NOBODY COULD READ. `feat!(git): …` is not a conventional header at all — the `!` belongs after
     * the scope — so commitlint reports "subject may not be empty; type may not be empty" about a line that
     * plainly has both, and the panel prints that verdict over a drafted message the user cannot get past by
     * retrying. It is the shape the prompt's own scopeless example (`feat!:`) invites, and it reached this
     * workspace's commit box five times in a thousand landings.
     *
     * Moved, never dropped: the marker is what the release tooling majors on, so losing it would trade an
     * unusable message for a wrong one. */
    expect(cleanCommitSubject("feat!(git): bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // With the other repairs, on one line, which is how they actually arrive.
    expect(cleanCommitSubject("Fix!(api):  Drop the legacy token route.")).toBe("fix(api)!: drop the legacy token route");
    // The legal spellings are already right and must come back untouched.
    expect(cleanCommitSubject("feat(git)!: bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    expect(cleanCommitSubject("feat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    // Marked on both sides is one marker's worth of meaning, and only one is legal.
    expect(cleanCommitSubject("feat!(git)!: bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // Nothing breaking ⇒ no marker invented.
    expect(cleanCommitSubject("feat(git): bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
});

/* THE SAME SPELLING, CAUGHT AT THE OTHER END. The repair above guards only what this daemon DRAFTS, and the
 * commit box records whatever is in it: a message drafted before that repair existed and still sitting on an
 * agent's card, an extension's, one a person typed around a marker they put on the wrong side of the scope.
 * Each of those reached git unread and came back as "subject may not be empty; type may not be empty" — the
 * verdict commitlint gives when its parser finds no header at all, about a line that plainly has one. */
test("the commit seam repairs the header spellings a conventional parser cannot read, and nothing else", () => {
    // The marker ahead of the scope, with everything under the subject carried through as written.
    expect(parsableMessage("feat!(git): bulk verbs use GitTarget scope")).toBe("feat(git)!: bulk verbs use GitTarget scope");
    expect(parsableMessage("feat!(git): bulk verbs\n\nRelease-Note: You can stage and commit in one step.")).toBe(
        "feat(git)!: bulk verbs\n\nRelease-Note: You can stage and commit in one step.",
    );
    // A colon with no space after it: the other spelling that parses as no header at all, and earns the same
    // unreadable pair of findings.
    expect(parsableMessage("feat(git):bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
    // A type outside the prescribed set is still a header when a scope or a marker says one was meant. Repairing
    // it is what turns its refusal into `type-enum`, a verdict that names the actual problem.
    expect(parsableMessage("update!(api): drop the legacy token route")).toBe("update(api)!: drop the legacy token route");

    /* AND WHAT IT MUST NOT TOUCH. Every rule below earns an accurate, actionable verdict from the hook, so the
     * message stays the author's: this daemon does not get to lower somebody's capital or strip their full stop,
     * and it cannot know which of those rules a given repo even enforces (commitlint.config.ts). */
    expect(parsableMessage("Feat(git): Bulk verbs take a scope.")).toBe("Feat(git): Bulk verbs take a scope.");
    expect(parsableMessage("feat(git): bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
    // Not a conventional header, however much it looks like a word in front of a colon. Rewriting this one to
    // `http: //host is down again` would be the repair inventing a convention nobody asked for.
    expect(parsableMessage("http://host is down again")).toBe("http://host is down again");
    expect(parsableMessage("Merge branch 'main' into topic")).toBe("Merge branch 'main' into topic");
    // An empty subject is not a spelling problem: `subject-empty` is then simply true, and being told so is the
    // useful answer.
    expect(parsableMessage("feat(git):")).toBe("feat(git):");
    expect(parsableMessage("")).toBe("");
});

test("a name leading the subject keeps its spelling instead of being mangled to fit the case rule", () => {
    /* THE FAILURE THIS EXISTS FOR, verbatim: the prompt tells the drafter to name things as the code spells
     * them, and `subject-case` reads a capital first letter as sentence-case and refuses the commit. Lowering
     * the letter would "fix" it by writing a token that is not in the code (`statusBadge`, `eSLint`), which
     * defeats the reason the subject names things at all. Backticked instead: `subject-case` short-circuits on a
     * subject that does not start with a cased letter, so the identifier survives exactly. */
    expect(cleanCommitSubject("feat(access): StatusBadge on the member roster")).toBe("feat(access): `StatusBadge` on the member roster");
    expect(cleanCommitSubject("fix(api): API tokens no longer expire early")).toBe("fix(api): `API` tokens no longer expire early");
    expect(cleanCommitSubject("feat: OAuth callback handles a state mismatch")).toBe("feat: `OAuth` callback handles a state mismatch");
    expect(cleanCommitSubject("refactor: ESLint config moves to oxlint")).toBe("refactor: `ESLint` config moves to oxlint");
    // A dotted name, capitalised by the model, and the comma after it stays outside the quotes.
    expect(cleanCommitSubject("style(ui): Ui.inputSm, applied to the invite controls")).toBe("style(ui): `Ui.inputSm`, applied to the invite controls");
    // A word that only LOOKS capitalised is a word, and `a11y` is how it is spelled anyway.
    expect(cleanCommitSubject("fix(ui): A11y labels on the roster")).toBe("fix(ui): a11y labels on the roster");
    // A name that already starts lowercase was never in danger: `subject-case` reads the first character only,
    // so quoting this one would be noise added to a message nothing was going to refuse.
    expect(cleanCommitSubject("perf: resolveRoleModels() no longer sorts on every read")).toBe(
        "perf: resolveRoleModels() no longer sorts on every read",
    );
});

test("an over-long subject is clipped on a word boundary at the header ceiling, never mid-word", () => {
    /* THE OTHER HALF OF THE SAME REFUSAL, and the bug that filed `… ui.inputSm on inv` into the commit box: the
     * subject was being scrubbed through the session-title cleaner, so a header whose real ceiling is 100 was
     * severed at exactly 80, mid-word, and the user had to finish typing it before they could commit. */
    const long = `feat(access): show the StatusBadge on the member roster and on expired tokens, with invite and mint controls sized to match`;
    const clipped = cleanCommitSubject(long);
    expect(clipped.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    // Whole words only, and no dangling punctuation where the cut landed.
    expect(long).toContain(clipped);
    expect(clipped).not.toMatch(/[\p{P}\s]$/u);
    expect(long.charAt(clipped.length)).toBe(" ");
    // The ceiling is git's, not a card's: an 80-character cut is what this replaced.
    expect(clipped.length).toBeGreaterThan(80);
});

test("asks for a lowercase verb first so the naming rule and the case rule stop contradicting each other", () => {
    const prompt = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    // The demand, and the worked pair beside it: the cheap rung follows an example where it argues with prose.
    expect(prompt).toContain("Begin the subject with a LOWERCASE word");
    expect(prompt).toContain("good: feat(access): show StatusBadge on the member roster");
    expect(prompt).toContain("bad:  feat(access): StatusBadge on the member roster");
    // And the instruction it used to contradict is still there: this was resolved, not dropped.
    expect(prompt).toContain("NAME THINGS");
    // The clause that caused it is gone, so nothing in the prompt asks for the whole subject to be lower case.
    expect(prompt).not.toContain("lower case after the colon");
});

test("skips a preamble to the line that is actually the message", () => {
    // The failure this prevents is a commit whose subject is "Here's the commit message:": the cheap rung
    // ignores "no preamble" often enough that anchoring on the type prefix is the only reliable start.
    const reply = "Sure! Here's the commit message:\nfix: stop the picker reordering on refresh\n\n- drops the sort in resolveRoleModels";
    const subject = reply.split("\n").find((line) => line.startsWith("fix:"))!;
    expect(cleanCommitSubject(reply)).toBe(subject);
});

test("a model that writes a body anyway has it dropped, not filed", () => {
    // The prompt asks for one line; this is what happens when the cheap rung answers with the shape it has seen
    // ten thousand times instead. There is no body reader to hold those lines, so they fall on the floor: the
    // subject is what the box gets, and a model ignoring the format cannot lengthen a commit message by it.
    const reply = ["feat: name sessions from the opening prompt", "", "- adds nameAgentTitle", "- rejects a reply that asks a question"].join("\n");
    const subject = reply.split("\n")[0]!;
    expect(cleanCommitSubject(reply)).toBe(subject);
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
    // …and the instruction ties the sentence to the "!" marker the release tooling majors on, spelled with the
    // scoped shape beside it: "mark the type" plus a scopeless example is what produced `feat!(git):`, the one
    // header commitlint reads as having neither.
    expect(wantsNote).toContain(`put a "!" immediately before the colon`);
    expect(wantsNote).toContain(`"feat(scope)!:" with one`);
    expect(wantsNote).toContain(`never "feat!(scope):"`);
});

test("a detected wire-contract shrink turns the breaking ask from a judgment call into a requirement", () => {
    const removed = [`OriginAgentSchema.properties.body`, `AgentEventSchema.oneOf[3]`];
    const forced = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], false, removed);
    // The removed surfaces are in front of the model, because the sentence has to be about THEM.
    expect(forced).toContain("OriginAgentSchema.properties.body");
    expect(forced).toContain("REQUIRED, not optional");
    // The marker's position is stated on this path too: it is the one that cannot be skipped, so a header the
    // hook refuses here costs the user the whole declaration, not just a note.
    expect(forced).toContain(`never "feat!(scope):"`);
    // Forced even with no changelog: the declaration is what the push gate reads, not a changelog courtesy.
    expect(forced).toContain("Breaking-Note:");
    // …and the judgment-call spelling is gone, so the prompt never says both "when in doubt, omit" and "required".
    expect(forced).not.toContain("when in doubt, omit it");
    expect(commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], true)).toContain("when in doubt, omit it");
});

test("markSubjectBreaking adds the marker the release tooling majors on, and only when it is missing", () => {
    expect(markSubjectBreaking("feat: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    expect(markSubjectBreaking("fix(contract): recut the lock")).toBe("fix(contract)!: recut the lock");
    // Already marked: nothing to add, and no second "!".
    expect(markSubjectBreaking("feat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    expect(markSubjectBreaking("fix(contract)!: recut the lock")).toBe("fix(contract)!: recut the lock");
    /* Marked in the illegal position: relocated, not doubled and not ignored. This is the enforcer for a shrink
     * the detector already proved, so a marker it could not see meant the removal shipped as a minor bump —
     * under a header the commit-msg hook was going to refuse anyway. */
    expect(markSubjectBreaking("feat!(git): bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // Not conventional: left for the commit-msg hook to reject rather than half-fixed here.
    expect(markSubjectBreaking("retire the legacy picker")).toBe("retire the legacy picker");
});

test("fallbackBreakingNote names the shrunk schemas once each and respects the note ceiling", () => {
    const note = fallbackBreakingNote([`OriginAgentSchema.properties.body`, `OriginAgentSchema.properties.title`, `AgentEventSchema.oneOf[3]`]);
    expect(note).toContain("OriginAgentSchema");
    expect(note).toContain("AgentEventSchema");
    // Two removals under one schema name it once: the sentence is for a human, not a path listing.
    expect(note.split("OriginAgentSchema").length).toBe(2);
    const flooded = fallbackBreakingNote(Array.from({ length: 40 }, (_, index) => `Schema${index}.properties.x`));
    expect(flooded.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
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

test("a note past the ceiling is cut where a word ends, and says that it was cut", () => {
    /* THE FAILURE, VERBATIM, off a real commit box: the store's ceiling is a hard slice (agents-registry.ts,
     * sanitizeLine), so a breaking sentence the cheap rung wrote past the ask arrived ending "…, GitStageSchema,
     * and numer" — half a word, in the one place where the sentence is everything a reader gets: a changelog
     * bullet, and the warning on an update card. */
    const long = `API clients must use GitTarget, GitIndexMoveSchema, and truncated staged/unstaged counts instead of RepoPaths, CommitSchema.all/paths, GitStageSchema, and numeric side totals.`;
    const clipped = cleanBreakingNote(`feat(git)!: bulk verbs take a scope\n\nBreaking-Note: ${long}`);
    expect(clipped.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    // What survives is a prefix of the sentence ending on a whole word, with the mark that says there was more.
    expect(clipped.endsWith("…")).toBe(true);
    expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
    expect(long.slice(clipped.length - 1)).toMatch(/^[\s\p{P}]/u);
    // Emphatically not where the hard slice landed, which is the whole point of the clip.
    expect(clipped).not.toContain("numer");
    expect(clipped).toContain("GitStageSchema");
    // The release note answers to the same ceiling and the same cut.
    expect(cleanReleaseNote(`feat: x\n\nRelease-Note: ${long}`).endsWith("…")).toBe(true);
    // A sentence that fits is left exactly as it was written: no mark, nothing to explain.
    const fits = `You can stage and commit every pending change in one step, including files not shown in the changes list.`;
    expect(cleanReleaseNote(`feat: x\n\nRelease-Note: ${fits}`)).toBe(fits);
});

test("a note-first reply still yields the subject, not the note", () => {
    expect(cleanCommitSubject("Release-Note: Your models stay put.\nfeat: ordered model picker")).toBe("feat: ordered model picker");
});

test("reads the breaking sentence off the reply, apart from the note", () => {
    const breaking = "The old picker layout is gone — use the new list.";
    const release = "The model picker is simpler now.";
    const reply = `feat!: retire the legacy picker\n\nRelease-Note: ${release}\nBreaking-Note: ${breaking}`;
    expect(cleanBreakingNote(reply)).toBe(breaking);
    // Each cleaner reads only its own trailer, whichever order the model wrote them in.
    expect(cleanReleaseNote(reply)).toBe(release);
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
