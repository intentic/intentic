import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { isolatedAgent } from "../registry/agents-store.testing.js";
import { type AgentArchiveDeps, BUILD_OUTPUT_QUIET_MS, sweepBuildOutputs } from "../registry/archive.js";
import { createLogger } from "../../logger.js";
import type { AgentWorktrees } from "./worktrees.js";

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

describe("sweepBuildOutputs", () => {
    const now = BUILD_OUTPUT_QUIET_MS;
    let checkout: string;

    beforeEach(() => {
        checkout = mkdtempSync(join(tmpdir(), "quiet-checkout-"));
        execFileSync("git", ["-C", checkout, "init", "-q"]);
        writeFileSync(join(checkout, ".gitignore"), "target/\n");
        writeFileSync(join(checkout, "Cargo.toml"), "");
        mkdirSync(join(checkout, "target", "debug"), { recursive: true });
        writeFileSync(join(checkout, "target", "debug", "app"), "binary");
    });
    afterEach(() => rmSync(checkout, { recursive: true, force: true }));

    const sweepDeps = (status: AgentSummary["status"] = "landed") =>
        unstubbed<AgentArchiveDeps>("archive", {
            agents: unstubbed<AgentArchiveDeps["agents"]>("agents", {
                list: () => [card({ status })],
                entry: () => isolatedAgent([{ repo: "root", base: "main" }]),
            }),
            conversations: unstubbed<AgentArchiveDeps["conversations"]>("conversations", { running: () => false, state: () => undefined }),
            agentWorktrees: unstubbed<AgentWorktrees>("worktrees", { presence: async () => "present", worktreeDir: () => checkout }),
            turns: { stop: async () => ({ stopped: false }) },
            turnEngine: { familyOf: () => ({ heads: ["c1"], members: [], records: new Map() }), cancelFamily: async () => [], cancelWatchersFor: async () => 0 },
            logger,
        });

    it("empties a quiet checkout's build output once, and walks it again only after the card moves", async () => {
        const prunedAt = new Map<string, number>();
        expect(await sweepBuildOutputs(sweepDeps(), now, BUILD_OUTPUT_QUIET_MS, () => 0, prunedAt)).toEqual(["c1"]);
        expect(existsSync(join(checkout, "target"))).toBe(false);
        expect(existsSync(join(checkout, "Cargo.toml"))).toBe(true);
        expect(prunedAt.get("c1")).toBe(0);
        // Rebuilt by a later look at the card that changed nothing: the remembered pass stands.
        mkdirSync(join(checkout, "target"));
        expect(await sweepBuildOutputs(sweepDeps(), now, BUILD_OUTPUT_QUIET_MS, () => 0, prunedAt)).toEqual([]);
        expect(existsSync(join(checkout, "target"))).toBe(true);
    });

    it("leaves the build output while a background command it started still runs, or a turn is in flight", async () => {
        expect(await sweepBuildOutputs(sweepDeps(), now, BUILD_OUTPUT_QUIET_MS, () => 1, new Map())).toEqual([]);
        expect(await sweepBuildOutputs(sweepDeps("running"), now, BUILD_OUTPUT_QUIET_MS, () => 0, new Map())).toEqual([]);
        expect(existsSync(join(checkout, "target", "debug", "app"))).toBe(true);
    });
});
