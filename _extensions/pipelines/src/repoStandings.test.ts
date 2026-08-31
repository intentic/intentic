import type { CiRepo, PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { repoStandings, standingNote } from "./repoStandings";

/* The board's running order. It is worth pinning down because getting it wrong is invisible: every repository
 * still renders, just in an order that buries the one thing the page exists to show. */

const repo = (name: string, hookWarning?: string): CiRepo => ({
    repo: name,
    host: "github",
    project: `radarsu/${name}`,
    url: `https://github.com/radarsu/${name}`,
    ...(hookWarning === undefined ? {} : { hookWarning }),
});

const run = (at: string, status: PipelineRun["status"], createdAt: number, branch = "main"): PipelineRun => ({
    repo: at,
    host: "github",
    project: `radarsu/${at}`,
    runId: createdAt,
    branch,
    sha: "abc1234",
    status,
    url: "u",
    createdAt,
});

test("a repository with a broken branch leads, whatever the discovery order was", () => {
    const standings = repoStandings(
        [repo("a-quiet"), repo("b-green"), repo("c-broken")],
        [run("b-green", "success", 90), run("c-broken", "failed", 10)],
    );
    expect(standings.map((standing) => standing.repo.repo)).toEqual(["c-broken", "b-green", "a-quiet"]);
    // Broken wins on tier, not on recency: b-green's run is the newer one by 80.
    expect(standings[0]).toMatchObject({ failing: 1, running: 0, silent: false });
});

test("running outranks green, and green outranks never-ran", () => {
    const standings = repoStandings([repo("green"), repo("never"), repo("moving")], [run("green", "success", 90), run("moving", "running", 10)]);
    expect(standings.map((standing) => standing.repo.repo)).toEqual(["moving", "green", "never"]);
});

test("a webhook warning outranks green and keeps the repository off the silent list", () => {
    const [first, second] = repoStandings([repo("green"), repo("warned", "Could not register the hook")], [run("green", "success", 90)]);
    expect(first?.repo.repo).toBe("warned");
    // No runs at all, and still not silent: the warning is the explanation for the silence, so it earns a
    // section rather than being folded away into the rail.
    expect(first).toMatchObject({ runs: [], silent: false });
    expect(second?.repo.repo).toBe("green");
});

test("inside a tier the newest run leads, and repositories with no runs fall back to their names", () => {
    const standings = repoStandings(
        [repo("z-silent"), repo("older"), repo("a-silent"), repo("newer")],
        [run("older", "success", 10), run("newer", "success", 90)],
    );
    expect(standings.map((standing) => standing.repo.repo)).toEqual(["newer", "older", "a-silent", "z-silent"]);
    expect(standings.filter((standing) => standing.silent).map((standing) => standing.repo.repo)).toEqual(["a-silent", "z-silent"]);
});

test("failing counts broken branches, not failed runs", () => {
    // One breakage three runs deep is one thing to fix: the same edge-not-level rule the rail badge runs on.
    const [only] = repoStandings([repo("one")], [run("one", "failed", 30), run("one", "failed", 20), run("one", "failed", 10)]);
    expect(only).toMatchObject({ failing: 1 });
    const [two] = repoStandings([repo("one")], [run("one", "failed", 30), run("one", "failed", 20, "feat")]);
    expect(two).toMatchObject({ failing: 2 });
});

test("the row's tooltip says the whole state the single number cannot", () => {
    const [broken] = repoStandings([repo("one")], [run("one", "failed", 30), run("one", "running", 20, "feat")]);
    const brokenNote = standingNote(broken!);
    expect(brokenNote).toContain(String(broken!.failing));
    expect(brokenNote).toContain(String(broken!.running));
    expect(brokenNote).toContain(String(broken!.runs.length));
    const [quiet] = repoStandings([repo("two", "no public URL")], []);
    const quietNote = standingNote(quiet!);
    expect(quiet!.runs).toHaveLength(0);
    expect(quiet!.repo.hookWarning).toBe("no public URL");
    expect(quietNote).toContain("webhook");
    expect(quietNote).not.toContain(String(broken!.failing));
    expect(brokenNote).not.toBe(quietNote);
});
