import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { isolatedAgent } from "../agents-store.testing.js";
import {
    type AgentArchiveDeps,
    BUILD_OUTPUT_QUIET_MS,
    type BuildOutputSweep,
    CheckoutBusy,
    INCREMENTAL_QUIET_MS,
    NO_QUIET,
    NORMAL_QUIET,
    type PrunedAt,
    quietOfSettings,
    sweepBuildOutputs,
} from "../archive.js";
import { createLogger } from "../../../logger.js";
import { createBuildOutputReaper } from "./build-output-reaper.js";
import type { AgentWorktrees } from "../../worktrees/worktrees.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const card = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
    id: "c1",
    status: "landed",
    provider: "claude",
    harness: "native",
    branch: "agent/c1",
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    ...overrides,
});

const CARGO_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";

let root: string;

// One checkout per conversation id under `root`, each a crate with a built `target/`.
const checkout = (id: string): string => {
    const dir = join(root, id);
    mkdirSync(join(dir, "target", "debug"), { recursive: true });
    execFileSync("git", ["-C", dir, "init", "-q"]);
    writeFileSync(join(dir, ".gitignore"), "target/\ntarget-*/\n");
    writeFileSync(join(dir, "Cargo.toml"), "");
    writeFileSync(join(dir, "target", "debug", "app"), "binary");
    return dir;
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quiet-checkouts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sweepDeps = (cards: readonly AgentSummary[], running: ReadonlySet<string> = new Set()) =>
    unstubbed<AgentArchiveDeps>("archive", {
        agents: unstubbed<AgentArchiveDeps["agents"]>("agents", {
            list: () => [...cards],
            entry: () => isolatedAgent([{ repo: "root", base: "main" }]),
        }),
        conversations: unstubbed<AgentArchiveDeps["conversations"]>("conversations", { running: (id) => running.has(id), state: () => undefined }),
        agentWorktrees: unstubbed<AgentWorktrees>("worktrees", { presence: async () => "present", worktreeDir: (id) => join(root, id) }),
        turns: { stop: async () => ({ stopped: false }) },
        turnEngine: { familyOf: (_, heads) => ({ heads, members: [], records: new Map() }), cancelFamily: async () => [], cancelWatchersFor: async () => 0 },
        logger,
    });

const pass = (overrides: Partial<BuildOutputSweep> = {}): BuildOutputSweep => ({
    now: BUILD_OUTPUT_QUIET_MS,
    quiet: NORMAL_QUIET,
    runningJobs: () => 0,
    prunedAt: new Map(),
    ...overrides,
});

describe("sweepBuildOutputs", () => {
    it("empties a quiet checkout's build output once, and walks it again only after the card moves", async () => {
        const dir = checkout("c1");
        const prunedAt: PrunedAt = new Map();
        expect(await sweepBuildOutputs(sweepDeps([card()]), pass({ prunedAt }))).toEqual([{ id: "c1", removed: ["target"] }]);
        expect(existsSync(join(dir, "target"))).toBe(false);
        expect(existsSync(join(dir, "Cargo.toml"))).toBe(true);
        expect(prunedAt.get("c1")).toEqual({ updatedAt: 0, scope: "all" });
        // Rebuilt by a later look at the card that changed nothing: the remembered pass stands.
        mkdirSync(join(dir, "target"));
        expect(await sweepBuildOutputs(sweepDeps([card()]), pass({ prunedAt }))).toEqual([]);
        expect(existsSync(join(dir, "target"))).toBe(true);
    });

    it("leaves the build output while a background command it started still runs, or a turn is in flight", async () => {
        const dir = checkout("c1");
        expect(await sweepBuildOutputs(sweepDeps([card()]), pass({ runningJobs: () => 1 }))).toEqual([]);
        expect(await sweepBuildOutputs(sweepDeps([card({ status: "running" })]), pass())).toEqual([]);
        expect(existsSync(join(dir, "target", "debug", "app"))).toBe(true);
    });

    // The sandbox-wide quiet moment it used to wait for never came on a busy sandbox (shinobi, 2026-11-02).
    it("sweeps a settled checkout while another conversation's turn runs, and leaves that one's", async () => {
        const settled = checkout("settled");
        const busy = checkout("busy");
        const cards = [card({ id: "settled" }), card({ id: "busy" })];
        expect(await sweepBuildOutputs(sweepDeps(cards, new Set(["busy"])), pass())).toEqual([{ id: "settled", removed: ["target"] }]);
        expect(existsSync(join(settled, "target"))).toBe(false);
        expect(existsSync(join(busy, "target", "debug", "app"))).toBe(true);
    });

    it("finds Cargo's output by its tag under any name, and stops a pressure pass once the disk has room", async () => {
        const first = checkout("landed");
        mkdirSync(join(first, "target-wasm", "release"), { recursive: true });
        writeFileSync(join(first, "target-wasm", "CACHEDIR.TAG"), CARGO_TAG);
        // Somebody else's tag is not Cargo's word.
        mkdirSync(join(first, "target-other"), { recursive: true });
        writeFileSync(join(first, "target-other", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n# made by another tool\n");
        const second = checkout("idle");
        const cards = [card({ id: "idle", status: "idle", updatedAt: 1 }), card({ id: "landed", updatedAt: 5 })];
        let checks = 0;
        // Room again after the first checkout: the idle one keeps its build.
        const enough = async (): Promise<boolean> => (checks++ > 0);
        const swept = await sweepBuildOutputs(sweepDeps(cards), pass({ now: 10, quiet: NO_QUIET, enough }));
        // In the order the directory lists them, which is the filesystem's.
        expect(swept.map(({ id, removed }) => ({ id, removed: removed.toSorted() }))).toEqual([{ id: "landed", removed: ["target", "target-wasm"] }]);
        expect(existsSync(join(first, "target-other"))).toBe(true);
        expect(existsSync(join(second, "target", "debug", "app"))).toBe(true);
    });
});

describe("incremental first", () => {
    // A cross build's caches sit one level deeper, beside a target triple (the wasm32 one shinobi built).
    const withIncremental = (id: string): string => {
        const dir = checkout(id);
        mkdirSync(join(dir, "target", "debug", "incremental", "app-1x2y"), { recursive: true });
        mkdirSync(join(dir, "target", "wasm32-unknown-unknown", "debug", "incremental"), { recursive: true });
        mkdirSync(join(dir, "target", "debug", "deps"), { recursive: true });
        writeFileSync(join(dir, "target", "debug", "deps", "libserde.rlib"), "rlib");
        return dir;
    };

    it("takes only Cargo's incremental caches after an hour idle, and the rest after the idle hours", async () => {
        const dir = withIncremental("c1");
        const prunedAt: PrunedAt = new Map();
        const idle = [card({ status: "idle" })];
        const swept = await sweepBuildOutputs(sweepDeps(idle), pass({ now: INCREMENTAL_QUIET_MS, prunedAt }));
        // In the order the directory lists them, which is the filesystem's.
        expect(swept.map(({ id, removed }) => ({ id, removed: removed.toSorted() }))).toEqual([
            { id: "c1", removed: ["target/debug/incremental", "target/wasm32-unknown-unknown/debug/incremental"] },
        ]);
        expect(existsSync(join(dir, "target", "debug", "deps", "libserde.rlib"))).toBe(true);
        expect(prunedAt.get("c1")).toEqual({ updatedAt: 0, scope: "incremental" });
        // The same card an hour later is not walked again for the same scope.
        expect(await sweepBuildOutputs(sweepDeps(idle), pass({ now: 2 * INCREMENTAL_QUIET_MS, prunedAt }))).toEqual([]);
        expect(await sweepBuildOutputs(sweepDeps(idle), pass({ now: BUILD_OUTPUT_QUIET_MS, prunedAt }))).toEqual([{ id: "c1", removed: ["target"] }]);
        expect(existsSync(join(dir, "target"))).toBe(false);
    });

    it("leaves a Gradle build folder whole on an incremental pass", async () => {
        const dir = withIncremental("c1");
        mkdirSync(join(dir, "app", "build", "intermediates"), { recursive: true });
        writeFileSync(join(dir, "app", "build.gradle"), "");
        writeFileSync(join(dir, ".gitignore"), "target/\nbuild/\n");
        await sweepBuildOutputs(sweepDeps([card({ status: "idle" })]), pass({ now: INCREMENTAL_QUIET_MS }));
        expect(existsSync(join(dir, "app", "build", "intermediates"))).toBe(true);
        expect(existsSync(join(dir, "target", "debug", "incremental"))).toBe(false);
    });

    it("follows the settings' idle hours: one hour takes everything at the hour", async () => {
        const dir = withIncremental("c1");
        const swept = await sweepBuildOutputs(sweepDeps([card({ status: "idle" })]), pass({ now: INCREMENTAL_QUIET_MS, quiet: quietOfSettings(1) }));
        expect(swept).toEqual([{ id: "c1", removed: ["target"] }]);
        expect(existsSync(join(dir, "target"))).toBe(false);
    });
});

describe("a shared Cargo target's layers (cargo-warm.ts)", () => {
    // A checkout whose `target` is only the overlay's mount point, and the layer under overlays/<id> holding what its
    // builds wrote over the snapshot.
    const overlaid = async (id: string): Promise<{ dir: string; layer: string; overlaysOf: (one: string) => string }> => {
        const dir = checkout(id);
        rmSync(join(dir, "target"), { recursive: true });
        mkdirSync(join(dir, "target"));
        const overlays = join(root, ".overlays");
        const layer = join(overlays, id, "target");
        mkdirSync(join(layer, "upper", "debug", "incremental", "app-1x2y"), { recursive: true });
        mkdirSync(join(layer, "upper", "debug", "deps"), { recursive: true });
        mkdirSync(join(layer, "work"), { recursive: true });
        writeFileSync(join(layer, "warm-lower"), `${HISTORY_ROOT}/cargo-warm/%2F/1700000000000-aaaaaaaaaaaa-bbbbbbbb\n`);
        return { dir, layer, overlaysOf: (one) => join(overlays, one) };
    };

    it("frees the layer with the checkout, and leaves the empty mount point where it stands", async () => {
        const { dir, layer, overlaysOf } = await overlaid("c1");
        expect(await sweepBuildOutputs(sweepDeps([card()]), pass({ overlaysOf }))).toEqual([{ id: "c1", removed: ["target"] }]);
        expect(existsSync(join(dir, "target"))).toBe(true);
        expect(existsSync(join(layer, "upper"))).toBe(false);
        expect(existsSync(join(layer, "warm-lower"))).toBe(false);
    });

    it("takes only the layer's incremental caches after an idle hour, keeping its pin", async () => {
        const { layer, overlaysOf } = await overlaid("c1");
        const swept = await sweepBuildOutputs(sweepDeps([card({ status: "idle" })]), pass({ now: INCREMENTAL_QUIET_MS, overlaysOf }));
        expect(swept).toEqual([{ id: "c1", removed: ["target/debug/incremental"] }]);
        expect(existsSync(join(layer, "upper", "debug", "deps"))).toBe(true);
        expect(existsSync(join(layer, "warm-lower"))).toBe(true);
    });

    it("names a layer's path reapable by the conversation that owns it", () => {
        // Siblings, as worktrees/ and overlays/ are on the history volume.
        const overlays = join(root, "overlays");
        const reaper = createBuildOutputReaper({
            archive: sweepDeps([card({ id: "settled" })]),
            worktreesRoot: join(root, "worktrees"),
            overlaysRoot: overlays,
            runningJobs: () => 0,
        });
        expect(reaper.reapable(join(overlays, "settled", "target"), 0)).toBe(true);
        expect(reaper.reapable(join(overlays, "unknown", "target"), 0)).toBe(false);
    });
});

describe("build-output reaper", () => {
    it("removes one conversation's build output on a press whatever its age, and refuses while it runs", async () => {
        const settled = checkout("settled");
        checkout("busy");
        const cards = [card({ id: "settled", status: "idle", updatedAt: Date.now() }), card({ id: "busy" })];
        const reaper = createBuildOutputReaper({ archive: sweepDeps(cards, new Set(["busy"])), worktreesRoot: root, runningJobs: () => 0 });
        expect(await reaper.reapOne("settled")).toEqual({ id: "settled", removed: ["target"] });
        expect(existsSync(join(settled, "target"))).toBe(false);
        await expect(reaper.reapOne("busy")).rejects.toThrow(CheckoutBusy);
        await expect(reaper.reapOne("nobody")).rejects.toThrow(CheckoutBusy);
    });

    it("reads the sweep's clock from its settings each pass", async () => {
        const dir = checkout("c1");
        const cards = [card({ status: "idle", updatedAt: Date.now() - INCREMENTAL_QUIET_MS })];
        const reaper = createBuildOutputReaper({ archive: sweepDeps(cards), worktreesRoot: root, runningJobs: () => 0, quiet: async () => quietOfSettings(1) });
        expect(await reaper.sweep(Date.now())).toEqual([{ id: "c1", removed: ["target"] }]);
        expect(existsSync(join(dir, "target"))).toBe(false);
    });

    it("names a checkout's build output reapable only while its conversation has nothing running", () => {
        const cards = [card({ id: "settled" }), card({ id: "busy" })];
        const reaper = createBuildOutputReaper({ archive: sweepDeps(cards, new Set(["busy"])), worktreesRoot: root, runningJobs: () => 0 });
        expect(reaper.reapable(join(root, "settled", "target"), 0)).toBe(true);
        expect(reaper.reapable(join(root, "busy", "target"), 0)).toBe(false);
        expect(reaper.reapable(join(root, "unknown", "target"), 0)).toBe(false);
        expect(reaper.reapable(join(root, "..", "elsewhere", "target"), 0)).toBe(false);
    });
});
