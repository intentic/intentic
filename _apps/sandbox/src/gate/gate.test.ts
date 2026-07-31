import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, OriginAgent, SandboxSettings } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test, vi } from "vitest";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { fileGateStore } from "./gate-store.js";
import { createLandingGate, fixPrompt, implicate } from "./gate.js";

// The gate touches sandboxSettings, gateStore, agents (for the fleet-idle check), agentOrigins and workspace; a
// cast keeps the fake that small. The store is a real one on a temp dir — persistence across reads is a thing
// several tests assert on.
const SETTINGS: Pick<SandboxSettings, "gateCommand" | "gateQuietMs" | "gateTimeoutMs" | "gateAutoFix"> = {
    gateCommand: "exit 0",
    gateQuietMs: 1_000,
    gateTimeoutMs: 60_000,
    gateAutoFix: false,
};

interface Fakes {
    readonly services: Services;
    readonly settings: { current: typeof SETTINGS };
    readonly busy: { ids: string[] };
    readonly origins: { paths: Record<string, string[]> };
    // How many times the check command has actually run — the debounce assertions count executions, not
    // verdicts, because collapsing a burst is precisely a claim about how often the child was spawned.
    readonly runs: () => number;
}

/* `ending` is the sugar the debounce tests need: it becomes a command that RECORDS the fact it ran and then
 * ends that way, so "a burst collapses into one run" can assert on executions rather than on the single verdict
 * five runs would also produce. Tests that care about the output pass `gateCommand` outright instead. */
const fakeServices = (over: Partial<typeof SETTINGS> & { ending?: string } = {}): Fakes & { readonly root: string } => {
    const root = mkdtempSync(join(tmpdir(), "gate-"));
    const { ending, ...fields } = over;
    const settings = {
        current: { ...SETTINGS, ...fields, ...(ending !== undefined ? { gateCommand: `echo ran >> ${join(root, "runs.log")}; ${ending}` } : {}) },
    };
    const busy: { ids: string[] } = { ids: [] };
    const origins: { paths: Record<string, string[]> } = { paths: {} };
    const services = {
        workspace: { root },
        // Under .intentic, exactly where composition puts it — not incidental: the fingerprint excludes that
        // directory, and a store parked anywhere else in the tree would have the gate hashing its own verdicts.
        gateStore: fileGateStore(join(root, ".intentic", "gate.json")),
        sandboxSettings: { get: async () => settings.current },
        agents: { ids: () => busy.ids, running: (id: string) => busy.ids.includes(id) },
        agentOrigins: {
            forRepo: async () => origins.paths,
            identify: (ids: Iterable<string>) =>
                Object.fromEntries([...ids].map((id) => [id, { title: `agent ${id}`, provider: "claude" } as OriginAgent])),
        },
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    } as unknown as Services;
    const log = join(root, "runs.log");
    return {
        services,
        settings,
        busy,
        origins,
        runs: () =>
            existsSync(log)
                ? readFileSync(log, "utf8")
                      .trimEnd()
                      .split("\n")
                      .filter((line) => line !== "").length
                : 0,
        root,
    };
};

// `discoverRepos` walks the real temp root and finds nothing, so every gate below sees exactly one repo ("root").
// A git runner standing in for the fingerprint's `add -A` + `write-tree`: `state` is the tree sha it reports, so
// moving it is how a test simulates content changing under a verdict. `calls` records what git was asked to do,
// for the tests that are about how OFTEN the gate reaches for it rather than what it learns.
const fakeGit = (state: { value: string }, calls: string[][] = []): GitRunner =>
    (async (_dir: string, args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] === "write-tree") {
            return { stdout: `${state.value}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
    }) as unknown as GitRunner;

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

/* ---- implicate: whose landed work does this failure name? ---- */

test("a failure naming an attributed path implicates only that path's agent", () => {
    const attributed = new Map([["root", { "src/a.ts": ["agent-1"], "src/b.ts": ["agent-2"] }]]);
    const found = implicate("FAIL src/a.ts > it works", attributed, (ids) =>
        Object.fromEntries([...ids].map((id) => [id, { title: id, provider: "claude" } as OriginAgent])),
    );
    expect(found).toEqual([{ agentId: "agent-1", title: "agent-1", provider: "claude", paths: ["src/a.ts"] }]);
});

// The case that makes this a gate rather than a blame machine: two deltas that each passed alone. Nobody is
// named, so EVERY agent with work in the tree comes back — with no paths, which is what says "not pinpointed".
test("a failure naming no attributed path implicates every landed agent, with no paths", () => {
    const attributed = new Map([["root", { "src/a.ts": ["agent-1"], "src/b.ts": ["agent-2"] }]]);
    const found = implicate("Error: 3 tests failed", attributed, (ids) =>
        Object.fromEntries([...ids].map((id) => [id, { title: id, provider: "claude" } as OriginAgent])),
    );
    expect(found.map((agent) => agent.agentId).toSorted()).toEqual(["agent-1", "agent-2"]);
    expect(found.every((agent) => agent.paths.length === 0)).toBe(true);
});

// A nested repo's runner prints paths relative to its own root, so the bare path has to match too — and the
// reported path keeps the repo prefix, because that is how the panel and the user name it.
test("a nested repo's path matches bare in the output and is reported repo-prefixed", () => {
    const attributed = new Map([["intentic", { "src/x.ts": ["agent-9"] }]]);
    const found = implicate("  ✗ src/x.ts:12:3", attributed, (ids) =>
        Object.fromEntries([...ids].map((id) => [id, { provider: "claude" } as OriginAgent])),
    );
    expect(found).toEqual([{ agentId: "agent-9", provider: "claude", paths: ["intentic/src/x.ts"] }]);
});

/* ---- fixPrompt: what the fixer is told ---- */

test("the fix prompt carries the command, the output and the do-not-commit constraint", () => {
    const prompt = fixPrompt(
        {
            status: "failed",
            command: "pnpm test",
            output: "FAIL src/a.ts",
            exitCode: 1,
            fingerprint: "abc",
            implicated: [{ agentId: "agent-1", title: "Add the thing", paths: ["src/a.ts"] }],
        },
        900_000,
    );
    expect(prompt).toContain("pnpm test");
    expect(prompt).toContain("FAIL src/a.ts");
    expect(prompt).toContain("exit 1");
    expect(prompt).toContain("Add the thing (agent-1): src/a.ts");
    expect(prompt).toContain("Do NOT commit");
    expect(prompt).toContain("main working tree");
});

// A timeout must never read as "tests failed" — the fixer has to know nothing finished, or it hunts an assertion
// that was never reached.
test("a timed-out check tells the fixer it never finished, not that it failed an assertion", () => {
    const prompt = fixPrompt({ status: "failed", command: "pnpm test", output: "", timedOut: true, fingerprint: "abc", implicated: [] }, 900_000);
    expect(prompt).toContain("did not finish");
    expect(prompt).toContain("15m");
    expect(prompt).not.toContain("exit ");
});

test("an unpinpointed failure is framed as an interaction between deltas, not as one agent's bug", () => {
    const prompt = fixPrompt(
        {
            status: "failed",
            command: "pnpm test",
            output: "3 failed",
            exitCode: 1,
            fingerprint: "abc",
            implicated: [
                { agentId: "a", paths: [] },
                { agentId: "b", paths: [] },
            ],
        },
        900_000,
    );
    expect(prompt).toContain("interaction BETWEEN deltas");
    expect(prompt).toContain("passed on its own branch");
});

/* ---- the debounce: a landing burst is ONE run ---- */

/* REAL timers throughout, with a quiet period shrunk to milliseconds — deliberately, and it is worth saying why
 * rather than leaving the next person to rediscover it. The gate's debounce drives a real child process, and
 * faking timers around one splits the clock from the event loop: `advanceTimersByTime` fast-forwards the
 * countdown but a spawned `sh` still exits on the real one, so the fake-timer version of these tests raced its
 * own children AND poisoned the tests after it (a gate left holding fake timer handles). Short real waits test
 * the same claim without the split. */
const QUIET_MS = 60;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a burst of lands collapses into a single check run", async () => {
    const { services, runs } = fakeServices({ gateQuietMs: QUIET_MS, ending: "exit 0" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }));
    // Five lands, each well inside the quiet window: every one after the first only pushes the countdown out.
    for (let land = 0; land < 5; land += 1) {
        gate.arm();
        await wait(QUIET_MS / 3);
    }
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    expect(runs()).toBe(1);
}, 20_000);

/* THE REGRESSION GUARD for the deferral this used to do. An earlier version waited for the fleet to fall idle
 * before running, reasoning that an agent mid-turn is about to land into this very tree. Agents in this workspace
 * run for HOURS, so a fleet of twenty with one long runner never presents an idle moment: the verdict stayed
 * `armed` indefinitely and the gate degraded into something only a manual click ever fired — which is how a red
 * composite reached CI with the gate switched on and configured.
 *
 * The tree after a land is the tree the user is about to stage, commit and push, whoever else is still working.
 * The busy fake stays permanently busy here, so reinstating any fleet check fails this. */
test("the check runs on the tree it has, even while the fleet is still working", async () => {
    const { services, busy, runs } = fakeServices({ gateQuietMs: QUIET_MS, ending: "exit 0" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }));
    busy.ids = ["running-for-hours"];
    gate.arm();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    expect(runs()).toBe(1);
}, 20_000);

/* ---- verdicts ---- */

test("a non-zero exit is a failed verdict carrying the output", async () => {
    const { services } = fakeServices({ gateCommand: "echo boom >&2; exit 3" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("failed"), { timeout: 5_000 });
    const verdict = await gate.verdict();
    expect(verdict.exitCode).toBe(3);
    expect(verdict.output).toContain("boom");
});

// The guard bug this whole module exists to avoid: a check that outruns its ceiling must be LOUD, never a pass
// and never a silent skip.
test("a check that outruns the timeout is failed and timedOut, never passed", async () => {
    // Below the schema's own 60s floor, which only guards what a user can type — the fake reads the field
    // directly, and a real ceiling would make this test take a minute to assert a branch that takes 150ms.
    const { services } = fakeServices({ gateCommand: "sleep 30", gateTimeoutMs: 150 });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("failed"), { timeout: 10_000 });
    expect((await gate.verdict()).timedOut).toBe(true);
}, 20_000);

test("a verdict goes stale when the tree moves under it, and says so without re-running", async () => {
    const tree = { value: "clean" };
    const { services } = fakeServices({ gateCommand: "exit 0" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit(tree));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    expect((await gate.verdict()).stale).toBe(false);
    tree.value = "someone edited a file";
    // Past the fingerprint's coalescing window, so the next read re-derives it.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const after = await gate.verdict();
    expect(after.status).toBe("passed");
    expect(after.stale).toBe(true);
}, 20_000);

/* ---- the fingerprint: what must stale a verdict, and what must not ---- */

/* REAL git and the REAL runner below, not the fake — because the claim under test is exactly that `add -A` into
 * a kept index plus `write-tree` tracks CONTENT rather than git's bookkeeping. A stubbed runner could only
 * restate the assumption, and the assumption is what was wrong: the previous fingerprint (HEAD plus `diff --raw`)
 * satisfied every fake-git test in this file and still got both of these backwards against real git — blind to an
 * unstaged edit, and moved by a stage or a commit that changed nothing. */
const initRepo = (root: string): void => {
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    execFileSync("git", ["config", "user.email", "gate@test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "gate"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "committed\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: root });
};

// Past the fingerprint's own coalescing window, so the next read re-derives instead of reusing the cached value.
const COALESCE_WAIT_MS = 2_100;

// The user's flow after the gate goes green: stage, then commit, then push. Neither step alters a byte of the
// tree the check ran over, so a verdict that went stale at either one would have the push guardrail objecting to
// every push ever made — which is the shape of "cries wolf" that gets a guardrail ignored and then removed.
test("staging and committing do not stale a verdict, because neither changes content", async () => {
    const { services, root } = fakeServices({ gateCommand: "exit 0" });
    initRepo(root);
    // Landed work: uncommitted, unstaged, which is how it actually arrives.
    writeFileSync(join(root, "a.txt"), "an agent landed this\n");
    const gate = createLandingGate(services, fakeWake([]));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    expect((await gate.verdict()).stale).toBe(false);

    execFileSync("git", ["add", "-A"], { cwd: root });
    await wait(COALESCE_WAIT_MS);
    expect((await gate.verdict()).stale).toBe(false);

    execFileSync("git", ["commit", "-qm", "the user commits"], { cwd: root });
    await wait(COALESCE_WAIT_MS);
    expect((await gate.verdict()).stale).toBe(false);
}, 30_000);

// The other direction, and the more dangerous one: an edit the verdict has not seen must show as stale rather
// than leaving a green badge over changed content. Unstaged on purpose — that is both how landed work arrives and
// the exact case the old fingerprint was blind to.
test("an unstaged in-place edit stales a verdict", async () => {
    const { services, root } = fakeServices({ gateCommand: "exit 0" });
    initRepo(root);
    const gate = createLandingGate(services, fakeWake([]));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    expect((await gate.verdict()).stale).toBe(false);
    writeFileSync(join(root, "a.txt"), "edited after the check ran\n");
    await wait(COALESCE_WAIT_MS);
    expect((await gate.verdict()).stale).toBe(true);
}, 30_000);

// The gate's own verdict file lives in the tree it fingerprints. If it counted, every persisted verdict would
// move the tree it describes and the badge would read stale forever.
test("the gate's own state does not stale its verdict", async () => {
    const { services, root } = fakeServices({ gateCommand: "exit 0" });
    initRepo(root);
    const gate = createLandingGate(services, fakeWake([]));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    // A second run rewrites .intentic/gate.json (twice — `running`, then the result) under the same content.
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 5_000 });
    await wait(COALESCE_WAIT_MS);
    expect((await gate.verdict()).stale).toBe(false);
}, 30_000);

/* THE FEEDBACK LOOP GUARD, and the reason the fingerprint is skipped rather than merely ignored while running.
 *
 * `stale` is unconditionally false for a running verdict, so the read cost nothing but a value nobody used —
 * except that the read IS a `git add -A` per repo, into an index under .intentic, and the panel polls the
 * verdict every 2s for exactly as long as a check runs. Every poll rewrote a file inside the watched tree; the
 * file watcher pushed that back to the browser as a workspace change; the browser refetched the tree and the
 * review set. Clicking "Re-run" flickered "Loading changes…" for the length of the suite, and the gate was
 * feeding itself the noise. Polls across the coalescing window, so a pass here is the skip and not the cache. */
test("polling a running verdict never touches git", async () => {
    const calls: string[][] = [];
    const { services } = fakeServices({ gateCommand: "sleep 6" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }, calls));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("running"), { timeout: 5_000 });
    // The run's own opening fingerprint is not what this is about — only what the polls after it cost.
    calls.length = 0;
    for (let poll = 0; poll < 2; poll += 1) {
        await wait(COALESCE_WAIT_MS);
        const verdict = await gate.verdict();
        expect(verdict.status).toBe("running");
        expect(verdict.stale).toBe(false);
    }
    expect(calls).toEqual([]);
    gate.cancel();
}, 30_000);

test("a cleared command reads as idle whatever is on disk, so the badge disappears", async () => {
    const { services, settings } = fakeServices({ gateCommand: "exit 1" });
    const gate = createLandingGate(services, fakeWake([]), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("failed"), { timeout: 5_000 });
    settings.current = { ...settings.current, gateCommand: "" };
    expect((await gate.verdict()).status).toBe("idle");
});

/* ---- the fix, and the loop it must not become ---- */

test("a red verdict with autoFix on wakes a main-tree fix turn seeded with the failure", async () => {
    const prompts: string[] = [];
    const { services, origins } = fakeServices({ gateCommand: "echo 'FAIL src/a.ts' ; exit 1", gateAutoFix: true });
    // Landed work in the tree, so the prompt has an attribution roster to carry as well as the output.
    origins.paths = { "src/a.ts": ["agent-1"] };
    const gate = createLandingGate(services, fakeWake(prompts), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 });
    expect(prompts[0]).toContain("FAIL src/a.ts");
    expect(prompts[0]).toContain("Do NOT commit");
    expect(prompts[0]).toContain("agent agent-1");
}, 20_000);

// The loop guard. The fix's own re-check inherits the fix record, so a fix that did not work cannot ask for a
// second one — one attempt per tree state, not one per failing run.
test("a fix that does not work is not retried automatically", async () => {
    const prompts: string[] = [];
    const { services } = fakeServices({ gateCommand: "exit 1", gateAutoFix: true });
    const gate = createLandingGate(services, fakeWake(prompts), fakeGit({ value: "clean" }));
    gate.run();
    // Long enough for the fix turn AND its re-check (which fails again) to settle.
    await vi.waitFor(async () => expect((await gate.verdict()).fix?.outcome).toBe("done"), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await gate.verdict()).status).toBe("failed");
    expect(prompts).toHaveLength(1);
}, 20_000);

test("a fix turn that errors records the error and skips the re-check", async () => {
    const prompts: string[] = [];
    const wake = fakeWake(prompts, [{ kind: "error", code: "no-credential", message: "no account" }]);
    const { services } = fakeServices({ gateCommand: "exit 1", gateAutoFix: true });
    const gate = createLandingGate(services, wake, fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).fix?.outcome).toBe("error"), { timeout: 10_000 });
    expect((await gate.verdict()).fix?.detail).toBe("no account");
    expect(prompts).toHaveLength(1);
}, 20_000);

test("autoFix off leaves the red verdict alone for the panel's button", async () => {
    const prompts: string[] = [];
    const { services } = fakeServices({ gateCommand: "exit 1", gateAutoFix: false });
    const gate = createLandingGate(services, fakeWake(prompts), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("failed"), { timeout: 10_000 });
    expect(prompts).toHaveLength(0);
    // The same fix the auto path would have run, on the user's click instead.
    await gate.fix();
    expect(prompts).toHaveLength(1);
}, 20_000);

test("a passed verdict never wakes a fixer", async () => {
    const prompts: string[] = [];
    const { services } = fakeServices({ gateCommand: "exit 0", gateAutoFix: true });
    const gate = createLandingGate(services, fakeWake(prompts), fakeGit({ value: "clean" }));
    gate.run();
    await vi.waitFor(async () => expect((await gate.verdict()).status).toBe("passed"), { timeout: 10_000 });
    await gate.fix();
    expect(prompts).toHaveLength(0);
}, 20_000);
