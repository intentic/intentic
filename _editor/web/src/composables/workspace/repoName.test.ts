import { expect, it } from "vitest";
import { repoNameFromUrl } from "./repoName";

/* The name a clone lands under is derived, not asked for — so the derivation is the whole form's correctness.
 * A wrong answer here is a repo at /work/repo.git, or at /work/ with no name at all. */

it("takes the last segment of a clone URL and drops the .git suffix", () => {
    expect(repoNameFromUrl(`https://github.com/owner/my-app.git`)).toBe(`my-app`);
    expect(repoNameFromUrl(`https://github.com/owner/my-app`)).toBe(`my-app`);
    // Case-insensitively — a host that spells it .GIT names the same repo.
    expect(repoNameFromUrl(`https://github.com/owner/my-app.GIT`)).toBe(`my-app`);
});

it("handles the scp-style form, whose separator is a colon rather than a slash", () => {
    expect(repoNameFromUrl(`git@github.com:owner/my-app.git`)).toBe(`my-app`);
    // …including a one-segment path, where the colon IS the last separator.
    expect(repoNameFromUrl(`git@host:my-app.git`)).toBe(`my-app`);
});

it("ignores surrounding whitespace and trailing slashes — both survive a paste", () => {
    expect(repoNameFromUrl(`  https://github.com/owner/my-app.git  `)).toBe(`my-app`);
    expect(repoNameFromUrl(`https://github.com/owner/my-app/`)).toBe(`my-app`);
    expect(repoNameFromUrl(`https://github.com/owner/my-app.git///`)).toBe(`my-app`);
});

it("yields nothing when there is no segment to name — the caller's cue that this isn't a repository yet", () => {
    expect(repoNameFromUrl(``)).toBe(``);
    expect(repoNameFromUrl(`   `)).toBe(``);
    expect(repoNameFromUrl(`///`)).toBe(``);
});

// A bare host has a last segment like anything else, and this does not pretend to know it isn't a repo: the
// daemon refuses the clone and says why, which is one rule in one place rather than a URL grammar in the
// browser that has to agree with it. The scp form is why a "must have a path" check would be wrong anyway —
// `git@host:repo` legitimately names a repo with no slash in it.
it("does not try to recognise a host — an address that can't be cloned fails at the clone", () => {
    expect(repoNameFromUrl(`https://github.com/`)).toBe(`github.com`);
});

it("keeps a name that merely contains dots, rather than cutting at the first one", () => {
    expect(repoNameFromUrl(`https://github.com/owner/my.app.js.git`)).toBe(`my.app.js`);
});
