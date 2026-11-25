import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackSpecInput } from "@intentic/sandbox-contract/schemas/deploys";
import type { ToolCall } from "../hosts/stacks/device-stacks.testing.js";
import { createRegistryChecks, imagesMoved } from "./deploy-registry.js";
import { DIGESTS, stackMachine, stackRepo, watchFixture } from "./deploys.testing.js";

// Newer images behind a stack's tags (deploy-registry.ts), against real git and the fake computer: the computer pulls the
// stack on its interval, a pull that recreated a container is recorded as a deploy of the commit it runs, one that
// changed nothing records nothing, and a stack mid-deploy, never deployed, owned elsewhere or offline is not pulled.

let root: string;
let state: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-deploy-registry-work-"));
    state = await mkdtemp(join(tmpdir(), "intentic-deploy-registry-state-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
});

const WEB: StackSpecInput = { name: "web", device: "rog", triggers: [{ registry: { every: "15m" } }] };
const MINUTE = 60_000;

// What compose prints applying a pull: a recreated container when a tag moved, `Running` when nothing did.
const UNCHANGED = " web Pulled\n Container web-web-1  Running\n";
const MOVED = " web Pulled\n Container web-web-1  Recreate\n Container web-web-1  Recreated\n Container web-web-1  Starting\n Container web-web-1  Started\n";
const NEWER = { web: "ghcr.io/o/web@sha256:2222222222222222222222222222222222222222222222222222222222222222" };

const pulls = (tools: readonly ToolCall[]): readonly ToolCall["args"][] => tools.filter((call) => call.tool === "stack_action").map((call) => call.args);

test("compose's own words tell a pull that moved an image from one that did not", () => {
    expect(imagesMoved(MOVED)).toBe(true);
    expect(imagesMoved(" Container web-web-1  Created\n")).toBe(true);
    expect(imagesMoved(UNCHANGED)).toBe(false);
    expect(imagesMoved("")).toBe(false);
});

test("a due stack is pulled; nothing new records nothing, and a recreated container records a deploy of the commit it runs", async () => {
    const head = await stackRepo(root, "shop", [WEB]);
    let printed = UNCHANGED;
    let digests = DIGESTS;
    const fixture = watchFixture(root, state, { tool: stackMachine({ action: () => printed, digests: () => digests }) });
    const deployed = await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    const start = Date.parse(deployed.endedAt ?? "");
    let clock = start + 5 * MINUTE;
    const registry = createRegistryChecks({ ...fixture.watchDeps, now: () => clock });

    expect(await registry.check()).toEqual([]);
    expect(pulls(fixture.tools)).toEqual([]);

    clock = start + 16 * MINUTE;
    expect(await registry.check()).toEqual([]);
    clock = start + 20 * MINUTE;
    expect(await registry.check()).toEqual([]);
    expect(pulls(fixture.tools)).toEqual([{ name: "web", op: "pull" }]);

    printed = MOVED;
    digests = NEWER;
    clock = start + 32 * MINUTE;
    const [queued] = await registry.check();
    const recorded = await fixture.engine.settled(queued?.id ?? "");

    expect(pulls(fixture.tools)).toHaveLength(2);
    expect(recorded).toMatchObject({ commit: head, ref: "main", outcome: "succeeded", digests: NEWER, trigger: { kind: "registry", detail: "newer images behind its tags (pulled every 15m)" } });
    expect((await fixture.engine.history({ repo: "shop", stack: "web" })).map((record) => record.trigger.kind)).toEqual(["registry", "manual"]);
});

test("a stack never deployed from here, owned by another sandbox, or deploying now is not pulled", async () => {
    await stackRepo(root, "shop", [WEB]);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let holding = false;
    const machine = stackMachine();
    const fixture = watchFixture(root, state, {
        tool: async (call) => {
            if (call.tool === "deploy_stack" && holding) {
                await held;
            }
            return await machine(call);
        },
    });
    const clock = Date.now() + 24 * 60 * MINUTE;
    const registry = createRegistryChecks({ ...fixture.watchDeps, now: () => clock });

    expect(await registry.check()).toEqual([]);
    await fixture.engine.settled((await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    fixture.engine.setStackState("shop", "web", "running", undefined, true);
    expect(await registry.check()).toEqual([]);
    fixture.engine.setStackState("shop", "web", "running");
    holding = true;
    const running = await fixture.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } });
    expect(await registry.check()).toEqual([]);
    release();
    await fixture.engine.settled(running.id);

    expect(pulls(fixture.tools)).toEqual([]);
});

test("a stack whose computer is not connected is not pulled", async () => {
    await stackRepo(root, "shop", [WEB]);
    const online = watchFixture(root, state, { tool: stackMachine() });
    await online.engine.settled((await online.engine.enqueue({ repo: "shop", stack: "web", trigger: { kind: "manual" } })).id);
    const offline = watchFixture(root, state, { tool: stackMachine(), online: false });
    const registry = createRegistryChecks({ ...offline.watchDeps, now: () => Date.now() + 24 * 60 * MINUTE });

    expect(await registry.check()).toEqual([]);
    expect(pulls(offline.tools)).toEqual([]);
});
