import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { NamespaceSetupError } from "../../../workload/namespace-holder.js";
import type { IsolationAnchor, IsolationPlan } from "../isolation.js";
import { withLayerRepair } from "./layer-repair.js";
import { layerOf } from "../turn-sandbox.js";

// The anchor's one repair, over real layer dirs and a stand-in holder: what it sets aside, when it tries again, and
// what it leaves alone. The holder itself is the kernel's (turn-sandbox.integration.test.ts); this is the decision.

const REFUSED = "namespace setup exited 1: bwrap: Can't make overlay mount on (null) with options upperdir=/proc/self/fd/6,workdir=/proc/self/fd/9,lowerdir=/proc/self/fd/10,userxattr: Invalid argument (no mount reported done)";
const refusal = (message: string = REFUSED): NamespaceSetupError => new NamespaceSetupError("exited", message, { steps: 0, awakeMs: 40, frozenMs: 0 });
// The repair only hands the anchor back; a read of any field but its pid fails the test.
const ANCHOR = unstubbed<IsolationAnchor>("anchor", { pid: 1 });

const bases: string[] = [];
afterEach(async () => {
    await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

// A conversation with its own checkout and one mirrored dependency tree, whose layer holds an install of its own.
const planWithLayer = async (): Promise<IsolationPlan> => {
    const base = await mkdtemp(join(tmpdir(), "layer-repair-"));
    bases.push(base);
    const plan: IsolationPlan = { worktree: join(base, "worktree"), root: join(base, "work"), mirrors: ["node_modules"], overlays: join(base, "overlays"), fence: undefined };
    const layer = layerOf(plan, "node_modules");
    await mkdir(join(layer, "upper", "dep"), { recursive: true });
    await mkdir(join(layer, "work", "work"), { recursive: true });
    await writeFile(join(layer, "upper", "dep", "built.js"), "the conversation's own install");
    return plan;
};

// A holder that refuses the first `refusals` starts, then comes up.
const holder = (refusals: number, error: () => Error = refusal) => {
    let starts = 0;
    return {
        start: async (): Promise<IsolationAnchor> => {
            starts += 1;
            if (starts <= refusals) {
                throw error();
            }
            return ANCHOR;
        },
        starts: () => starts,
    };
};

test("a refused overlay is tried once more over fresh layers, the old ones kept aside, and the repair is told", async () => {
    const plan = await planWithLayer();
    const layer = layerOf(plan, "node_modules");
    const told: number[] = [];
    const once = holder(1);
    await expect(withLayerRepair(plan, once.start, (layers) => told.push(layers))).resolves.toBe(ANCHOR);
    expect(once.starts()).toBe(2);
    expect(told).toEqual([1]);
    // The layer starts empty, and what it held is moved, not deleted: a sandbox still running may have it mounted.
    expect(existsSync(join(layer, "upper"))).toBe(false);
    const [stamp] = await readdir(join(layer, "set-aside"));
    expect(await readFile(join(layer, "set-aside", stamp ?? "", "upper", "dep", "built.js"), "utf8")).toBe("the conversation's own install");
});

test("a second refusal goes up as it came, for the turn to be refused as workspace-broken", async () => {
    const plan = await planWithLayer();
    const twice = holder(2);
    await expect(withLayerRepair(plan, twice.start)).rejects.toBeInstanceOf(NamespaceSetupError);
    expect(twice.starts()).toBe(2);
});

test("nothing is set aside for a refusal no layer caused, a stall, or a plan with no layers of its own", async () => {
    const plan = await planWithLayer();
    const layer = layerOf(plan, "node_modules");
    const notOverlay = holder(1, () => refusal("namespace setup exited 1: bwrap: execvp sh: No such file or directory"));
    await expect(withLayerRepair(plan, notOverlay.start)).rejects.toBeInstanceOf(NamespaceSetupError);
    const stalled = holder(1, () => new NamespaceSetupError("stalled", "namespace setup stalled: overlay", { steps: 0, awakeMs: 10_000, frozenMs: 0 }));
    await expect(withLayerRepair(plan, stalled.start)).rejects.toBeInstanceOf(NamespaceSetupError);
    // The main tree's plan may name the workspace itself as where layers live: it is never touched.
    const main = holder(1);
    await expect(withLayerRepair({ ...plan, worktree: plan.root }, main.start)).rejects.toBeInstanceOf(NamespaceSetupError);
    expect([notOverlay.starts(), stalled.starts(), main.starts()]).toEqual([1, 1, 1]);
    expect(existsSync(join(layer, "upper", "dep", "built.js"))).toBe(true);
});
