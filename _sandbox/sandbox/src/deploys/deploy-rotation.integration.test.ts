import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { deployEnvironments } from "./deploy-environments.js";
import type { DeployWatch } from "./deploy-watch.js";
import { stackMachine, stackRepo, watchFixture } from "./deploys.testing.js";

// A secret rotated under a running stack (deploy-rotation.ts), through the watch as the daemon starts it: each deploy
// leaves keyed marks of the values it received (never the values, nor a plain hash of one), a change in the store shows
// on the board, and is acted on once, by telling the owner or by deploying the stack again, as its manifest says.

let root: string;
let state: string;
let started: DeployWatch | undefined;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploy-rotation-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploy-rotation-state-"));
});

afterEach(async () => {
    started?.stop();
    started = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

// Values to find if they leak: nothing else in a file, a record or an event would ever contain them.
const FIRST = "first-value-6c1f";
const SECOND = "second-value-9ab2";
const THIRD = "third-value-03dd";

const WEB: StackSpecInput = { name: "web", device: "rog", env: { API_TOKEN: "{{secret:API_TOKEN}}" } };

// A granted `web` deployed once with API_TOKEN at FIRST, its marks written.
const deployedOnce = async (spec: StackSpecInput) => {
    const head = await stackRepo(root, "shop", [spec]);
    const fixture = watchFixture(root, state, { stored: { API_TOKEN: FIRST }, tool: stackMachine() });
    await fixture.engine.grant({ repo: "shop", stack: "web" }, "owner@example.com");
    await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    // Read into a shape of its own: a matcher handed the store's own objects may write itself into them.
    await waitFor(
        async () => expect((await fixture.watchDeps.marks.all()).map((entry) => [entry.repo, entry.stack, Object.keys(entry.deployed)])).toEqual([["shop", "web", ["API_TOKEN"]]]),
        SETTLES,
    );
    started = fixture.watch;
    return { ...fixture, head };
};

const changedOf = (messages: readonly { readonly type: string }[]): number => messages.filter((message) => message.type === "secrets_changed").length;

test("a deploy's marks hold no value nor a plain hash of one, and under notify each change is on the board and told once", async () => {
    const fixture = await deployedOnce(WEB);
    const marksFile = await readFile(join(state, "deploy-secret-marks.json"), "utf8");
    for (const encoding of ["hex", "base64", "base64url"] as const) {
        expect(marksFile).not.toContain(createHash("sha256").update(FIRST).digest(encoding));
    }
    expect(marksFile).not.toContain(FIRST);

    // Changed while nothing was watching: found as the watch starts.
    fixture.stored["API_TOKEN"] = SECOND;
    await fixture.watch.start();
    await waitFor(() => expect(changedOf(fixture.messages)).toBe(1), SETTLES);
    const board = await deployEnvironments({
        root,
        device: fixture.deps.device,
        deviceCards: fixture.deps.deviceCards,
        records: fixture.engine.records,
        grants: fixture.engine.grants,
        stackState: fixture.engine.stackState,
        secretsChanged: fixture.engine.secretsChanged,
        forgeProblem: fixture.engine.forgeProblem,
    });
    expect(board.environments).toMatchObject([{ stack: "web", secretsChanged: ["API_TOKEN"] }]);
    expect(fixture.messages.find((message) => message.type === "secrets_changed")).toMatchObject({
        channelId: "shop:web",
        content: "API_TOKEN changed in the secret store since shop web on rog was last deployed: it still runs with the old value until it is deployed again",
        extra: { repo: "shop", stack: "web", device: "rog", secrets: ["API_TOKEN"] },
    });

    // The same change again tells nothing; a further one does.
    fixture.secretsChanged();
    fixture.stored["API_TOKEN"] = THIRD;
    fixture.secretsChanged();
    await waitFor(() => expect(changedOf(fixture.messages)).toBe(2), SETTLES);
    expect(changedOf(fixture.messages)).toBe(2);

    // Deployed with the new value, the stack runs what the store holds again.
    await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    await waitFor(() => expect(fixture.engine.secretsChanged("shop", "web")).toEqual([]), SETTLES);
    expect(JSON.stringify([fixture.messages, await fixture.engine.records(), await readFile(join(state, "deploy-secret-marks.json"), "utf8")])).not.toMatch(
        new RegExp(`${FIRST}|${SECOND}|${THIRD}`),
    );
});

test("under redeploy, a rotated secret deploys the stack again, once per change, at the commit it runs, with the new value", async () => {
    const fixture = await deployedOnce({ ...WEB, onSecretChange: "redeploy" });
    await fixture.watch.start();
    const redeploys = async () => (await fixture.engine.history({ repo: "shop", stack: "web" })).filter((entry) => entry.trigger.kind === "secret-change");

    fixture.stored["API_TOKEN"] = SECOND;
    fixture.secretsChanged();
    fixture.secretsChanged();
    const [first] = await waitFor(async () => {
        expect(await redeploys()).toMatchObject([{ trigger: { kind: "secret-change", detail: "API_TOKEN changed in the secret store" } }]);
        return await redeploys();
    }, SETTLES);
    const done = await fixture.engine.settled(first?.id ?? "");
    await waitFor(() => expect(fixture.engine.secretsChanged("shop", "web")).toEqual([]), SETTLES);
    // Nothing new since that deploy: nothing to do. Then one more change: one more deploy, and only one.
    fixture.secretsChanged();
    fixture.stored["API_TOKEN"] = THIRD;
    fixture.secretsChanged();
    const [last] = await waitFor(async () => {
        expect(await redeploys()).toHaveLength(2);
        return await redeploys();
    }, SETTLES);
    await fixture.engine.settled(last?.id ?? "");

    expect(done).toMatchObject({ outcome: "succeeded", commit: fixture.head });
    const sent = fixture.tools.filter((call) => call.tool === "deploy_stack").map((call) => call.args["env"]);
    expect(sent).toEqual([`API_TOKEN=${FIRST}\n`, `API_TOKEN=${SECOND}\n`, `API_TOKEN=${THIRD}\n`]);
    expect(changedOf(fixture.messages)).toBe(0);
});
