import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { CiPass } from "./deploy-triggers.js";
import { DIGESTS, restack, stackMachine, stackRepo, watchFixture } from "./deploys.testing.js";

// What deploys by itself from CI and from another stack (deploy-triggers.ts), against real git and the fake computer:
// which passing job or run picks which stack, that one event queues one deploy however often it arrives, that an older
// commit never replaces a newer one, and that a stack coming up promotes the stacks following it on its images.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploy-triggers-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploy-triggers-state-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

// No secrets, so no grant is needed for these to deploy.
const stack = (name: string, triggers: StackSpecInput["triggers"]): StackSpecInput => ({ name, device: "rog", triggers });

const passed = (sha: string, over: Partial<CiPass> = {}): CiPass => ({
    host: "github",
    repo: "shop",
    branch: "main",
    sha,
    runId: 41,
    workflow: "Release",
    url: "https://github.com/acme/shop/actions/runs/41",
    ...over,
});
const job = (name: string, id = 7) => ({ id, name });

test("a passing job deploys each stack whose trigger names it, on its branch and workflow, and a passing run each that names no job", async () => {
    const head = await stackRepo(root, "shop", [
        stack("web", [{ ci: { branch: "main", workflow: "Release", job: "publish" } }]),
        stack("api", [{ ci: { branch: "main" } }]),
        stack("docs", [{ ci: { branch: "develop", job: "publish" } }]),
    ]);
    const { watch } = watchFixture(root, state, { tool: stackMachine() });

    expect(await watch.ciPassed(passed(head, { job: job("build", 1) }))).toEqual([]);
    expect(await watch.ciPassed(passed(head, { job: job("publish", 2), workflow: "Nightly" }))).toEqual([]);
    expect(await watch.ciPassed(passed(head, { job: job("publish", 3), branch: "feature" }))).toEqual([]);
    const fromJob = await watch.ciPassed(passed(head, { job: job("publish", 4), url: "https://github.com/acme/shop/actions/runs/41/job/4" }));
    const fromRun = await watch.ciPassed(passed(head));

    expect(fromJob).toMatchObject([
        {
            stack: "web",
            commit: head,
            ref: "main",
            trigger: { kind: "ci", detail: `job "publish" of "Release" passed on main (run 41)`, url: "https://github.com/acme/shop/actions/runs/41/job/4" },
        },
    ]);
    expect(fromRun).toMatchObject([{ stack: "api", commit: head, trigger: { kind: "ci", detail: `the run of "Release" passed on main (run 41)` } }]);
});

test("GitLab names no workflow, so a trigger naming one is not narrowed there", async () => {
    const head = await stackRepo(root, "shop", [stack("web", [{ ci: { branch: "main", workflow: "Release", job: "publish" } }])]);
    const { watch } = watchFixture(root, state, { tool: stackMachine() });

    const queued = await watch.ciPassed(passed(head, { host: "gitlab", workflow: undefined, job: job("publish") }));

    expect(queued.map((record) => record.stack)).toEqual(["web"]);
});

test("a redelivered job, and the run that passes after it, queue the commit once", async () => {
    const head = await stackRepo(root, "shop", [stack("web", [{ ci: { branch: "main", job: "publish" } }, { ci: { branch: "main" } }])]);
    const { watch, engine } = watchFixture(root, state, { tool: stackMachine() });

    const first = await watch.ciPassed(passed(head, { job: job("publish") }));
    const redelivered = await watch.ciPassed(passed(head, { job: job("publish") }));
    const run = await watch.ciPassed(passed(head));

    expect(first).toHaveLength(1);
    expect([redelivered, run]).toEqual([[], []]);
    expect((await engine.records()).map((record) => record.commit)).toEqual([head]);
});

test("an older commit never replaces the one the stack runs, and a newer one deploys", async () => {
    const older = await stackRepo(root, "shop", [stack("web", [{ ci: { branch: "main" } }])]);
    const deployed = await restack(root, "shop", [stack("web", [{ ci: { branch: "main" } }])], "deployed");
    const newer = await restack(root, "shop", [stack("web", [{ ci: { branch: "main" } }])], "newer");
    const { watch, engine, logged } = watchFixture(root, state, { tool: stackMachine() });
    const [running] = await watch.ciPassed(passed(deployed, { runId: 2 }));
    await engine.settled(running?.id ?? "");

    const late = await watch.ciPassed(passed(older, { runId: 1 }));
    const next = await watch.ciPassed(passed(newer, { runId: 3 }));

    expect(late).toEqual([]);
    expect(logged).toContainEqual(
        expect.objectContaining({ message: "deploys: skipped, the stack already runs or waits on this commit or a newer one", commit: older, standing: running?.id }),
    );
    expect(next.map((record) => record.commit)).toEqual([newer]);
});

test("a stack that comes up promotes each stack following it, at its commit with its images pinned, and a rollback promotes nothing", async () => {
    const head = await stackRepo(root, "shop", [stack("staging", [{ ci: { branch: "main" } }]), stack("production", [{ after: { stack: "staging" } }])]);
    const { watch, engine } = watchFixture(root, state, { tool: stackMachine() });

    const [staged] = await watch.ciPassed(passed(head));
    const done = await engine.settled(staged?.id ?? "");
    const promoted = await waitFor(async () => {
        const [record] = await engine.history({ repo: "shop", stack: "production" });
        expect(record).toMatchObject({ stack: "production" });
        return record;
    }, SETTLES);

    expect(done.outcome).toBe("succeeded");
    expect(promoted).toMatchObject({ commit: head, ref: "main", pins: DIGESTS, trigger: { kind: "after", detail: `after staging (${done.id})` } });
    const rolledBack = await engine.settled((await engine.rollback({ repo: "shop", stack: "staging", to: done.id })).id);
    expect(rolledBack.outcome).toBe("succeeded");
    await engine.settled(promoted?.id ?? "");
    expect((await engine.history({ repo: "shop", stack: "production" })).map((record) => record.trigger.kind)).toEqual(["after"]);
});
