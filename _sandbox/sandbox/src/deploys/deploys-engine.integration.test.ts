import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeployRecord, StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import { fileDeploysStore } from "./deploys-store.js";
import { RESTARTED } from "./deploys-engine.js";
import { deployFixture, restack, stackRepo } from "./deploys.testing.js";
import type { ToolAnswer, ToolCall } from "../hosts/stacks/device-stacks.testing.js";

// The deploys engine against real git and the fake computer (deploys.testing.ts): what a managed deploy sends the machine
// and keeps on its record, how each stack's lane runs one deploy at a time and replaces the one waiting, what a restart
// leaves behind, and how a failure the machine reports puts the stack back on its last good deploy, images pinned.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploys-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploys-state-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

// A value to find if it leaks: nothing else in a record, an event or a call would ever contain it.
const TOKEN = "tok-5f1e9b77c0d2";
const STORED = { API_TOKEN: TOKEN };

const WEB: StackSpecInput = {
    name: "web",
    device: "rog",
    env: { API_TOKEN: "{{secret:API_TOKEN}}", TAG: "{{deploy:sha8}}" },
    health: { timeoutSeconds: 60, http: ["http://127.0.0.1:8080/health"] },
};

const DIGESTS = { web: "ghcr.io/o/web@sha256:1111111111111111111111111111111111111111111111111111111111111111" };

// The computer: no stacks listed, and every deploy coming up with the digests above; `deploy` answers a deploy instead.
const machine =
    (deploy?: (call: ToolCall) => Promise<ToolAnswer>) =>
    async (call: ToolCall): Promise<ToolAnswer> => {
        if (call.tool === "list_stacks") {
            return { text: JSON.stringify({ root: "/home/me/.intentic/stacks", stacks: [] }) };
        }
        if (deploy !== undefined) {
            return await deploy(call);
        }
        const result = { path: "/home/me/.intentic/stacks/web", output: `hook printed ${TOKEN}\n Container web-1  Started\n`, digests: DIGESTS, envDigest: "e".repeat(64), healthySeconds: 12 };
        return { text: JSON.stringify(result) };
    };

const deployed = (tools: readonly ToolCall[]): readonly ToolCall[] => tools.filter((call) => call.tool === "deploy_stack");

test("a granted stack deploys its commit with a .env the daemon rendered, and keeps names on its record, never a value", async () => {
    const head = await stackRepo(root, "shop", [WEB]);
    const { engine, tools, uses, messages, recordsPath } = deployFixture(root, state, { stored: STORED, tool: machine() });
    await engine.grant({ repo: "shop", stack: "web" }, "owner@example.com");

    const queued = await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual", detail: "by owner@example.com" } });
    const record = await engine.settled(queued.id);

    expect(record).toMatchObject({
        repo: "shop",
        stack: "web",
        device: "rog",
        commit: head,
        ref: "main",
        outcome: "succeeded",
        digests: DIGESTS,
        envDigest: "e".repeat(64),
        healthySeconds: 12,
        secretNames: ["API_TOKEN"],
        outputTail: "hook printed {{secret:API_TOKEN}}\n Container web-1  Started\n",
    });
    const [call] = deployed(tools);
    expect(call?.args).toEqual({
        source: expect.stringMatching(/^\/home\/me\/\.intentic\/runs\/stack-web\//),
        name: "web",
        composeFile: "compose.yaml",
        commit: head,
        mode: "images",
        env: `API_TOKEN=${TOKEN}\nTAG=${head.slice(0, 8)}\n`,
        health: { timeoutSeconds: 60, http: ["http://127.0.0.1:8080/health"] },
    });
    expect(uses).toEqual([{ name: "API_TOKEN", lane: "deploy", detail: "web on rog", at: expect.any(Number) }]);
    expect(messages.map(({ type, channelId, extra }) => ({ type, channelId, extra }))).toEqual([
        { type: "deploy_succeeded", channelId: "shop:web", extra: { id: record.id, repo: "shop", stack: "web", commit: head, device: "rog", outcome: "succeeded", trigger: "manual" } },
    ]);
    // Only the machine ever held the value: the records file, the record and the event never did.
    expect(await readFile(recordsPath, "utf8")).not.toContain(TOKEN);
    expect(JSON.stringify([record, messages])).not.toContain(TOKEN);
});

test("an agent without stacks-managed is refused before anything is packed, saying to update it", async () => {
    await stackRepo(root, "shop", [WEB]);
    const { engine, tools, staging, messages } = deployFixture(root, state, { stored: STORED, tool: machine(), features: ["stacks", "programs"] });
    await engine.grant({ repo: "shop", stack: "web" }, undefined);

    const record = await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);

    expect(record).toMatchObject({
        outcome: "refused",
        error: `The agent on "rog" is too old to take a stack this sandbox manages (its .env, registry logins, hooks, health checks and image pins): update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
    });
    expect(tools).toEqual([]);
    expect(staging).toEqual([]);
    expect(messages.map((message) => message.type)).toEqual(["deploy_refused"]);
});

test("a secret the owner has not granted refuses the deploy, and a grant covers only what HEAD read when given", async () => {
    await stackRepo(root, "shop", [WEB]);
    const { engine, tools, uses } = deployFixture(root, state, { stored: { ...STORED, DB_PASSWORD: "pw-77aa31" }, tool: machine() });

    const ungranted = await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    expect(ungranted).toMatchObject({
        outcome: "refused",
        secretNames: ["API_TOKEN"],
        error: `"API_TOKEN" is not granted to "web" on "rog": only the owner lets a stack receive a secret (\`deploys grant shop web\` asks them on a card).`,
    });

    await engine.grant({ repo: "shop", stack: "web" }, "owner@example.com");
    await restack(root, "shop", [{ ...WEB, env: { ...WEB.env, DB_PASSWORD: "{{secret:DB_PASSWORD}}" } }], "reads one more");
    const more = await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    expect(more).toMatchObject({ outcome: "refused", secretNames: ["API_TOKEN", "DB_PASSWORD"] });
    expect(more.error).toContain(`"DB_PASSWORD" is not granted to "web" on "rog"`);
    expect(deployed(tools)).toEqual([]);
    expect(uses).toEqual([]);
    expect(await engine.grants()).toEqual([
        { repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN"], grantedBy: "owner@example.com", grantedAt: expect.any(String) },
    ]);
});

test("a newer deploy replaces the one waiting, never the one running, and the stack runs one deploy at a time", async () => {
    const first = await stackRepo(root, "shop", [WEB]);
    const second = await restack(root, "shop", [WEB], "second");
    const third = await restack(root, "shop", [WEB], "third");
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let reached = (): void => {};
    const running = new Promise<void>((resolve) => {
        reached = resolve;
    });
    let inFlight = 0;
    let overlapped = false;
    const { engine, tools } = deployFixture(root, state, {
        stored: STORED,
        tool: machine(async (call) => {
            inFlight += 1;
            overlapped ||= inFlight > 1;
            reached();
            await held;
            inFlight -= 1;
            return { text: JSON.stringify({ path: "/home/me/.intentic/stacks/web", output: "", digests: DIGESTS }) };
        }),
    });
    await engine.grant({ repo: "shop", stack: "web" }, undefined);

    const a = await engine.enqueue({ repo: "shop", stack: "web", commit: first, trigger: { kind: "ci" } });
    await running;
    const b = await engine.enqueue({ repo: "shop", stack: "web", commit: second, trigger: { kind: "ci" } });
    const c = await engine.enqueue({ repo: "shop", stack: "web", commit: third.slice(0, 10), trigger: { kind: "ci" } });
    expect(await engine.settled(b.id)).toMatchObject({ outcome: "superseded", error: `A newer deploy (${c.id}, at ${third.slice(0, 12)}) replaced it while it waited.` });
    release();

    expect([(await engine.settled(a.id)).outcome, (await engine.settled(c.id)).outcome]).toEqual(["succeeded", "succeeded"]);
    expect(deployed(tools).map((call) => call.args["commit"])).toEqual([first, third]);
    expect(overlapped).toBe(false);
});

test("after a restart a deploy left running ends failed, an older waiting one is replaced, and the newest one runs", async () => {
    const first = await stackRepo(root, "shop", [WEB]);
    const second = await restack(root, "shop", [WEB], "second");
    const third = await restack(root, "shop", [WEB], "third");
    const left = fileDeploysStore(join(state, "deploys.json"));
    const record = (id: string, commit: string, outcome: DeployRecord["outcome"], queuedAt: string): DeployRecord => ({
        id,
        repo: "shop",
        stack: "web",
        device: "rog",
        commit,
        trigger: { kind: "ci" },
        outcome,
        queuedAt,
        secretNames: [],
    });
    await left.put(record("dep-1", first, "running", "2026-11-25T10:00:00.000Z"));
    await left.put(record("dep-2", second, "queued", "2026-11-25T10:01:00.000Z"));
    await left.put(record("dep-3", third, "queued", "2026-11-25T10:02:00.000Z"));
    const { engine, tools, messages } = deployFixture(root, state, { stored: STORED, tool: machine() });
    await engine.grant({ repo: "shop", stack: "web" }, undefined);

    await engine.start();

    expect(await engine.settled("dep-3")).toMatchObject({ outcome: "succeeded", commit: third });
    expect(await engine.settled("dep-1")).toMatchObject({ outcome: "failed", error: RESTARTED });
    expect(await engine.settled("dep-2")).toMatchObject({ outcome: "superseded" });
    expect(deployed(tools).map((call) => call.args["commit"])).toEqual([third]);
    expect(messages.map((message) => `${message.type} ${String(message.extra?.["id"])}`).toSorted()).toEqual(["deploy_failed dep-1", "deploy_succeeded dep-3"]);
});

test("a deploy the machine says failed puts the stack back on its last good commit, with that deploy's images pinned", async () => {
    const good = await stackRepo(root, "shop", [WEB]);
    const bad = await restack(root, "shop", [WEB], "breaks health");
    const { engine, tools, messages } = deployFixture(root, state, {
        stored: STORED,
        tool: machine(async (call) =>
            call.args["commit"] === bad
                ? { text: `web did not come up healthy in 60 s: GET http://127.0.0.1:8080/health answered 502 (it saw ${TOKEN})`, refused: true }
                : { text: JSON.stringify({ path: "/home/me/.intentic/stacks/web", output: "", digests: DIGESTS }) },
        ),
    });
    await engine.grant({ repo: "shop", stack: "web" }, undefined);
    const current = await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", commit: good, trigger: { kind: "manual" } })).id);

    const broken = await engine.settled((await engine.enqueue({ repo: "shop", stack: "web", commit: bad, trigger: { kind: "ci" } })).id);

    expect(broken).toMatchObject({
        outcome: "rolled-back",
        rolledBackTo: current.id,
        error: "web did not come up healthy in 60 s: GET http://127.0.0.1:8080/health answered 502 (it saw {{secret:API_TOKEN}})",
    });
    const rollbacks = (await engine.history({ repo: "shop", stack: "web" })).filter((record) => record.trigger.kind === "rollback");
    expect(rollbacks).toMatchObject([{ outcome: "succeeded", commit: good, pins: DIGESTS, trigger: { kind: "rollback", detail: `after ${broken.id} failed, back to ${current.id}` } }]);
    expect(deployed(tools).map((call) => ({ commit: call.args["commit"], pins: call.args["pins"] }))).toEqual([
        { commit: good, pins: undefined },
        { commit: bad, pins: undefined },
        { commit: good, pins: DIGESTS },
    ]);
    expect(messages.map((message) => message.type)).toEqual(["deploy_succeeded", "deploy_succeeded", "deploy_rolled_back"]);
    expect(JSON.stringify(await engine.history({ repo: "shop", stack: "web" }))).not.toContain(TOKEN);
});

test("a promotion deploys the other stack at the commit and image digests the first one runs", async () => {
    const STAGING: StackSpecInput = { ...WEB, name: "staging" };
    const PRODUCTION: StackSpecInput = { ...WEB, name: "production" };
    const head = await stackRepo(root, "shop", [STAGING, PRODUCTION]);
    const { engine, tools } = deployFixture(root, state, { stored: STORED, tool: machine() });
    await engine.grant({ repo: "shop", stack: "staging" }, undefined);
    await engine.grant({ repo: "shop", stack: "production" }, undefined);
    const staged = await engine.settled((await engine.enqueue({ repo: "shop", stack: "staging", trigger: { kind: "manual" } })).id);

    const promoted = await engine.settled((await engine.promote("shop", "staging", "production")).id);

    expect(promoted).toMatchObject({ stack: "production", commit: head, pins: DIGESTS, outcome: "succeeded", trigger: { kind: "promote", detail: `from staging (${staged.id})` } });
    expect(deployed(tools).map((call) => [call.args["name"], call.args["pins"]])).toEqual([
        ["staging", undefined],
        ["production", DIGESTS],
    ]);
});

test("asking for a stack, a commit or a repository that is not there is refused before anything is queued", async () => {
    const head = await stackRepo(root, "shop", [WEB]);
    const { engine } = deployFixture(root, state, { stored: STORED, tool: machine() });
    await expect(engine.enqueue({ repo: "shop", stack: "api", trigger: { kind: "manual" } })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: `"shop" at ${head.slice(0, 12)} does not declare "api": it declares web.`,
    });
    await expect(engine.enqueue({ repo: "shop", stack: "web", commit: "abcdef1", trigger: { kind: "manual" } })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `"shop" has no commit abcdef1 here, and fetching its remote failed: this suite's repositories have no remote`,
    });
    await expect(engine.enqueue({ repo: "../elsewhere", stack: "web", trigger: { kind: "manual" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await engine.records()).toEqual([]);
});
