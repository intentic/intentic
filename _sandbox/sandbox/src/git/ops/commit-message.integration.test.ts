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

// Run against real repos, not fakes: index and worktree disagree constantly, and a fake runner could pass while the
// prompt describes changes the commit won't contain.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (dir: string, message: string): Promise<string> => sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);

// Concatenates all patch blocks; per-file split is tested separately below.
const patchOf = (diff: RepoDiff): string => diff.blocks.map((block) => block.text).join("\n");

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A repo with two commits (their subjects set a house style) and a .gitignore hiding .env*.
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
    expect(patchOf(diff)).not.toContain("not part of this commit");
});

test("describes the WORKTREE for Commit all, new files included: `git add -A` sweeps them, so the message must too", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited in place\n");
    await writeFile(join(dir, "fresh.txt"), "brand new content\n");

    const diff = await collectRepoDiff("root", dir, { all: true });

    expect(patchOf(diff)).toContain("edited in place");
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
    expect(patchOf(diff)).not.toContain("somebody else's edit");
    expect(diff.summary).toContain("mine.txt");
    expect(patchOf(diff)).toContain("an untracked file inside the subset");
    expect(diff.summary).not.toContain("theirs.txt");
});

test("keeps the diff flags out of the pathspec: `--` ends the option list, so `--stat` after it is a filename", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "edited\n");

    const diff = await collectRepoDiff("root", dir, { paths: ["a.txt"] });

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
    // An unborn repo: no commits, so every git read here exits non-zero.
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

    expect(prompt).toContain("feat");
    expect(prompt).toContain("fix");
    expect(prompt).toContain("revert");
    expect(prompt).toContain("NAME THINGS");
    expect(prompt).toContain("files that changed");
});

test("tells nothing about the session that asked for the work: the diff is the only witness", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "a.txt"), "x\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    expect(prompt).not.toContain("tasked with");
    expect(prompt.toLowerCase()).not.toContain("session");
});

test("spends the budget per file, so a small meaningful change survives a huge one beside it", async () => {
    const dir = await tempRepo();
    // Named to sort first and sized past the whole prompt's allowance, so the per-file budget rule is actually
    // exercised.
    await writeFile(join(dir, "aaa-huge.txt"), `${"line of noise\n".repeat(20_000)}`);
    await writeFile(join(dir, "zzz-small.txt"), "the change this commit is actually about\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    expect(prompt).toContain("the change this commit is actually about");
    expect(prompt).toContain("line of noise");
    expect(prompt).toContain("truncated");
});

test("names generated files without spending the budget on them", async () => {
    const dir = await tempRepo();
    await writeFile(join(dir, "package-lock.json"), `{"lockfileVersion":3,"packages":{${'"x":{"resolved":"noise"},'.repeat(400)}}}\n`);
    await writeFile(join(dir, "src.txt"), "the reason for the lockfile change\n");
    await sh(dir, "add", "-A");

    const prompt = commitMessagePrompt([await collectRepoDiff("root", dir, {})]);

    // The lockfile records that dependencies moved; src.txt carries why.
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
    // The file list is built before the budget is applied, so it survives even when the diff is clipped.
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

// Each case is a real commit-msg rejection; asserted together since a message often breaks more than one rule at once.
test("repairs the mechanical rules a commit-msg hook refuses, and leaves the sentence alone", () => {
    // Leading capital on an ordinary word: lowered.
    expect(cleanCommitSubject("feat(ui): Redesign the sandbox access view")).toBe("feat(ui): redesign the sandbox access view");
    // Trailing period, either single or repeated: stripped.
    expect(cleanCommitSubject("fix: stop the picker reordering.")).toBe("fix: stop the picker reordering");
    expect(cleanCommitSubject("fix: stop the picker reordering...")).toBe("fix: stop the picker reordering");
    // Capitalised type and an oddly spaced colon: both fixed.
    expect(cleanCommitSubject("Feat:  add autofill")).toBe("feat: add autofill");
    // An all-caps subject has no identifiers to protect, so it's lowered whole.
    expect(cleanCommitSubject("fix: STOP THE PICKER REORDERING")).toBe("fix: stop the picker reordering");
    // Nothing wrong: left untouched, including a name mid-line.
    expect(cleanCommitSubject("feat(access): show StatusBadge on the member roster")).toBe("feat(access): show StatusBadge on the member roster");
});

test("a breaking marker written ahead of the scope is moved rather than left for the hook to refuse", () => {
    // `feat!(git):` isn't a conventional header (`!` belongs after the scope), so commitlint can't parse subject or
    // type; the marker is moved, never dropped, since release tooling majors on it.
    expect(cleanCommitSubject("feat!(git): bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // Combined with the other repairs on one line, as they arrive in practice.
    expect(cleanCommitSubject("Fix!(api):  Drop the legacy token route.")).toBe("fix(api)!: drop the legacy token route");
    // Already-legal spellings pass through untouched.
    expect(cleanCommitSubject("feat(git)!: bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    expect(cleanCommitSubject("feat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    // Marked on both sides collapses to the one legal marker.
    expect(cleanCommitSubject("feat!(git)!: bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // Nothing breaking ⇒ no marker invented.
    expect(cleanCommitSubject("feat(git): bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
});

// Catches unparsable header spellings regardless of source (an agent's card, an extension, hand-typed): all read as the
// same "subject/type may not be empty" verdict.
test("the commit seam repairs the header spellings a conventional parser cannot read, and nothing else", () => {
    // Text below the subject line passes through unchanged.
    expect(parsableMessage("feat!(git): bulk verbs use GitTarget scope")).toBe("feat(git)!: bulk verbs use GitTarget scope");
    expect(parsableMessage("feat!(git): bulk verbs\n\nRelease-Note: You can stage and commit in one step.")).toBe(
        "feat(git)!: bulk verbs\n\nRelease-Note: You can stage and commit in one step.",
    );
    // A colon with no space after it is the other unparsable spelling.
    expect(parsableMessage("feat(git):bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
    // An unlisted type still counts as a header with a scope or marker; repair turns the refusal into `type-enum`.
    expect(parsableMessage("update!(api): drop the legacy token route")).toBe("update(api)!: drop the legacy token route");

    // What must not be touched: every rule below should reach the hook as an accurate verdict, since this daemon can't
    // know which rules a given repo enforces (commitlint.config.ts).
    expect(parsableMessage("Feat(git): Bulk verbs take a scope.")).toBe("Feat(git): Bulk verbs take a scope.");
    expect(parsableMessage("feat(git): bulk verbs take a scope")).toBe("feat(git): bulk verbs take a scope");
    // `http://` isn't a conventional header despite the colon; rewriting it would invent a convention.
    expect(parsableMessage("http://host is down again")).toBe("http://host is down again");
    expect(parsableMessage("Merge branch 'main' into topic")).toBe("Merge branch 'main' into topic");
    // An empty subject isn't a spelling problem; `subject-empty` being true is already the useful answer.
    expect(parsableMessage("feat(git):")).toBe("feat(git):");
    expect(parsableMessage("")).toBe("");
});

test("a name leading the subject keeps its spelling instead of being mangled to fit the case rule", () => {
    // Lowering a leading identifier's capital would write a token not in the code; backticking it instead makes
    // `subject-case` skip a subject that doesn't start with a cased letter.
    expect(cleanCommitSubject("feat(access): StatusBadge on the member roster")).toBe("feat(access): `StatusBadge` on the member roster");
    expect(cleanCommitSubject("fix(api): API tokens no longer expire early")).toBe("fix(api): `API` tokens no longer expire early");
    expect(cleanCommitSubject("feat: OAuth callback handles a state mismatch")).toBe("feat: `OAuth` callback handles a state mismatch");
    expect(cleanCommitSubject("refactor: ESLint config moves to oxlint")).toBe("refactor: `ESLint` config moves to oxlint");
    // A dotted name; the trailing comma stays outside the backticks.
    expect(cleanCommitSubject("style(ui): Ui.inputSm, applied to the invite controls")).toBe("style(ui): `Ui.inputSm`, applied to the invite controls");
    // `a11y` only looks capitalised; it's spelled that way regardless, so it's lowered like any word.
    expect(cleanCommitSubject("fix(ui): A11y labels on the roster")).toBe("fix(ui): a11y labels on the roster");
    // Already lowercase-first: `subject-case` only reads the first character, so nothing here needed quoting.
    expect(cleanCommitSubject("perf: resolveRoleModels() no longer sorts on every read")).toBe(
        "perf: resolveRoleModels() no longer sorts on every read",
    );
});

test("an over-long subject is clipped on a word boundary at the header ceiling, never mid-word", () => {
    // The subject's real ceiling is 100 characters, not 80; a cut must land on a word boundary, never mid-word.
    const long = `feat(access): show the StatusBadge on the member roster and on expired tokens, with invite and mint controls sized to match`;
    const clipped = cleanCommitSubject(long);
    expect(clipped.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    // No dangling punctuation left at the cut, on top of the word boundary.
    expect(long).toContain(clipped);
    expect(clipped).not.toMatch(/[\p{P}\s]$/u);
    expect(long.charAt(clipped.length)).toBe(" ");
    // The ceiling is git's, not a card's: an 80-character cut is what this replaced.
    expect(clipped.length).toBeGreaterThan(80);
});

test("asks for a lowercase verb first so the naming rule and the case rule stop contradicting each other", () => {
    const prompt = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    expect(prompt).toContain("Begin the subject with a LOWERCASE word");
    expect(prompt).toContain("good: feat(access): show StatusBadge on the member roster");
    expect(prompt).toContain("bad:  feat(access): StatusBadge on the member roster");
    expect(prompt).toContain("NAME THINGS");
    expect(prompt).not.toContain("lower case after the colon");
});

test("skips a preamble to the line that is actually the message", () => {
    // Anchors on the type prefix, since a preamble line often precedes it.
    const reply = "Sure! Here's the commit message:\nfix: stop the picker reordering on refresh\n\n- drops the sort in resolveRoleModels";
    const subject = reply.split("\n").find((line) => line.startsWith("fix:"))!;
    expect(cleanCommitSubject(reply)).toBe(subject);
});

test("a model that writes a body anyway has it dropped, not filed", () => {
    // There's no body reader, so anything after the first line is just dropped, not stored.
    const reply = ["feat: name sessions from the opening prompt", "", "- adds nameAgentTitle", "- rejects a reply that asks a question"].join("\n");
    const subject = reply.split("\n")[0]!;
    expect(cleanCommitSubject(reply)).toBe(subject);
});

test("asks for one line and no body at all", () => {
    const prompt = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    expect(prompt).toContain("ONE LINE ONLY");
    // The shown format itself must have no body line: a model copies the shape it's shown.
    expect(prompt).not.toContain("one fact per line");
    expect(prompt).not.toContain("body lines");
});

test("asks for a release note only when the repo keeps a changelog", () => {
    const noNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }]);
    expect(noNote).not.toContain("Release-Note:");

    const wantsNote = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], true);
    expect(wantsNote).toContain("Release-Note: <one plain sentence>");
    // Stated in the prompt, not just enforced after: an unstated ceiling gets written past and cut mid-word.
    expect(wantsNote).toContain(`at most ${MAX_NOTE_LENGTH} characters`);
    // Omission matters most: a model noting every commit refills the changelog with noise.
    expect(wantsNote).toContain("OMIT the Release-Note line entirely");
    // The breaking note rides the same gate: no changelog, no breaking sentence either.
    expect(noNote).not.toContain("Breaking-Note:");
    expect(wantsNote).toContain("Breaking-Note:");
    // The scoped example pairs with the "!" instruction, since a scopeless example alone invites `feat!(scope):`.
    expect(wantsNote).toContain(`put a "!" immediately before the colon`);
    expect(wantsNote).toContain(`"feat(scope)!:" with one`);
    expect(wantsNote).toContain(`never "feat!(scope):"`);
});

test("a detected wire-contract shrink turns the breaking ask from a judgment call into a requirement", () => {
    const removed = [`OriginAgentSchema.properties.body`, `AgentEventSchema.oneOf[3]`];
    const forced = commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], false, removed);
    // Removed surfaces are shown to the model since the sentence must name them.
    expect(forced).toContain("OriginAgentSchema.properties.body");
    expect(forced).toContain("REQUIRED, not optional");
    // Marker position is stated here too: a hook refusal on this path costs the whole declaration.
    expect(forced).toContain(`never "feat!(scope):"`);
    // Forced even with no changelog: the declaration is what the push gate reads, not a changelog courtesy.
    expect(forced).toContain("Breaking-Note:");
    // The judgment-call spelling is gone: the prompt never says both "omit" and "required".
    expect(forced).not.toContain("when in doubt, omit it");
    expect(commitMessagePrompt([{ repo: "root", subjects: [], summary: "M\ta.txt", blocks: [] }], true)).toContain("when in doubt, omit it");
});

test("markSubjectBreaking adds the marker the release tooling majors on, and only when it is missing", () => {
    expect(markSubjectBreaking("feat: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    expect(markSubjectBreaking("fix(contract): recut the lock")).toBe("fix(contract)!: recut the lock");
    // Already marked: nothing added, no second `!`.
    expect(markSubjectBreaking("feat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
    expect(markSubjectBreaking("fix(contract)!: recut the lock")).toBe("fix(contract)!: recut the lock");
    // Relocates the marker rather than doubling or dropping it, enforcing a shrink already detected.
    expect(markSubjectBreaking("feat!(git): bulk verbs take a scope")).toBe("feat(git)!: bulk verbs take a scope");
    // Not conventional: left for the commit-msg hook to reject rather than half-fixed here.
    expect(markSubjectBreaking("retire the legacy picker")).toBe("retire the legacy picker");
});

test("fallbackBreakingNote names the shrunk schemas once each and respects the note ceiling", () => {
    const note = fallbackBreakingNote([`OriginAgentSchema.properties.body`, `OriginAgentSchema.properties.title`, `AgentEventSchema.oneOf[3]`]);
    expect(note).toContain("OriginAgentSchema");
    expect(note).toContain("AgentEventSchema");
    // Two removals under one schema are named once: the sentence is for a human, not a path list.
    expect(note.split("OriginAgentSchema").length).toBe(2);
    const flooded = fallbackBreakingNote(Array.from({ length: 40 }, (_, index) => `Schema${index}.properties.x`));
    expect(flooded.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
});

test("reads the note off the reply, and says so when there isn't one", () => {
    expect(cleanReleaseNote("feat: ordered model picker\n\nRelease-Note: Your models stay in the order you set them.")).toBe(
        "Your models stay in the order you set them.",
    );
    // The common case: the model judged the change invisible from outside and omitted the line.
    expect(cleanReleaseNote("refactor: split the picker component")).toBe("");
    // Packaging comes off a note exactly as it comes off a subject.
    expect(cleanReleaseNote('feat: x\n\nRelease-Note: "Your models stay put."')).toBe("Your models stay put.");
    // A model that leads with the note has still answered correctly, in the other order.
    expect(cleanReleaseNote("Release-Note: Your models stay put.\nfeat: ordered model picker")).toBe("Your models stay put.");
});

test("a note past the ceiling is cut where a word ends, and says that it was cut", () => {
    // The store's own ceiling (agents-registry.ts, sanitizeLine) is a hard slice, not word-aware, so a sentence past it
    // can be cut mid-word before this ever sees it.
    const long = `API clients must use GitTarget, GitIndexMoveSchema, and truncated staged/unstaged counts instead of RepoPaths, CommitSchema.all/paths, GitStageSchema, and numeric side totals.`;
    const clipped = cleanBreakingNote(`feat(git)!: bulk verbs take a scope\n\nBreaking-Note: ${long}`);
    expect(clipped.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    // What survives ends on a whole word, marked to say more was cut.
    expect(clipped.endsWith("…")).toBe(true);
    expect(long.startsWith(clipped.slice(0, -1))).toBe(true);
    expect(long.slice(clipped.length - 1)).toMatch(/^[\s\p{P}]/u);
    // Not where the hard slice would have landed.
    expect(clipped).not.toContain("numer");
    expect(clipped).toContain("GitStageSchema");
    // The release note answers to the same ceiling and the same cut.
    expect(cleanReleaseNote(`feat: x\n\nRelease-Note: ${long}`).endsWith("…")).toBe(true);
    // A sentence that fits is left exactly as written, with no mark.
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
    // The common case: nothing was taken away, so no line was written.
    expect(cleanBreakingNote("feat: ordered model picker\n\nRelease-Note: Your models stay put.")).toBe("");
    // A breaking line never leaks into the subject, same as the note.
    expect(cleanCommitSubject("Breaking-Note: The old picker is gone.\nfeat!: retire the legacy picker")).toBe("feat!: retire the legacy picker");
});

test("leaves quotes that are part of the subject alone", () => {
    // Only a symmetric surrounding pair counts as packaging; an apostrophe or inner quote is the message itself.
    expect(cleanCommitSubject(`fix: don't drop the "all" flag`)).toBe(`fix: don't drop the "all" flag`);
});

test("reports an empty answer as empty, so the caller can say the model said nothing", () => {
    expect(cleanCommitSubject("")).toBe("");
    expect(cleanCommitSubject("   \n\n  ")).toBe("");
    expect(cleanCommitSubject("```\n```")).toBe("");
});
