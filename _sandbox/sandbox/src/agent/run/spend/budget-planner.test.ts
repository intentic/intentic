import type { ServiceFacts } from "@intentic/sandbox-contract/models/plan-pools";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { RunOut, RunOuts } from "../../../usage/run-outs.js";
import { beginPulse, endPulse } from "../turn/turn-pulse.js";
import { claimBudget, dropClaim, forecastBudget, pickAccount, type PlannerDeps, resetBudgetPlanner } from "./budget-planner.js";

/* 2026-10-20, 15:45: ten Opus children spawned in four minutes onto two Claude accounts that both read five-hour 84%
   left. Two agents ran on radarsu, the parent on artur. With what the sandbox had learned of a point's cost, the plan
   is to spread them and hold what the two cannot carry. */

const NOW = Date.parse("2026-10-20T15:45:00Z");
const S = Math.floor(NOW / 1000);
const M = 1_000_000;

const claude = (account: string, fiveHourUsed: number, fiveHourResetH: number, weeklyUsed: number): ServiceFacts => ({
    account,
    label: `${account}@example.com`,
    usage: {
        windows: [
            { kind: "five_hour", utilization: fiveHourUsed, resetsAt: S + fiveHourResetH * 3_600, gates: "all", rounded: true },
            { kind: "seven_day", utilization: weeklyUsed, resetsAt: S + 72 * 3_600, gates: "all", rounded: true },
        ],
        measuredAt: NOW,
    },
});

const READINGS = [claude("radarsu", 16, 2.7, 55), claude("artur", 16, 3.3, 71)];

const deps = (settings: Record<string, unknown> = {}): PlannerDeps => ({
    burnRates: {
        ready: async () => {},
        tokensPerPoint: (_provider, _account, kind) => (kind === "five_hour" ? 1.1 * M : 9.3 * M),
        modelPace: () => ({ tokensPerHour: 9 * M, childHours: 1.5 }),
        reading: async () => {},
        turnEnded: async () => {},
    },
    providerRefusals: { onFile: async () => ({}), record: async () => {}, settle: async () => {}, drop: async () => false, flapping: async () => new Set(), onChange: () => () => {} },
    runOuts: { read: async () => ({}), record: async () => {} },
    sandboxSettings: { get: async () => SandboxSettingsSchema.parse(settings) },
});

const running = (conversationId: string, account: string): void =>
    beginPulse({ conversationId, turnId: `t-${conversationId}`, provider: "claude", harness: "native", model: "claude-opus-5-5", account, startedAt: NOW - 5 * 60_000 });

beforeEach(() => {
    resetBudgetPlanner();
    running("ci-fix", "radarsu");
    running("noble-sable", "radarsu");
    running("brave-vale", "artur");
});

afterEach(() => {
    for (const id of ["ci-fix", "noble-sable", "brave-vale"]) {
        endPulse(id, `t-${id}`);
    }
});

describe("the fan-out planner", () => {
    it("spreads ten children claimed at once across both accounts and holds the one they cannot carry", async () => {
        const claims = await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                claimBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: READINGS, childId: `sub-${index}`, childrenRunning: index }, () => NOW),
            ),
        );
        const placed = claims.flatMap((claim) => (claim.go ? [claim.account] : []));
        expect(placed).toHaveLength(9);
        expect(placed.filter((account) => account === "radarsu")).toHaveLength(4);
        expect(placed.filter((account) => account === "artur")).toHaveLength(5);
        const held = claims.find((claim) => !claim.go);
        // Asked again once radarsu's five-hour window reopens, a minute past it.
        expect(held?.go === false ? held.retryAt : undefined).toBe(NOW + 2.7 * 3_600_000 + 60_000);
    });

    it("frees a claim's place when its start fails", async () => {
        for (let index = 0; index < 9; index += 1) {
            await claimBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: READINGS, childId: `sub-${index}`, childrenRunning: index }, () => NOW);
        }
        dropClaim("sub-0");
        expect((await claimBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: READINGS, childId: "sub-9", childrenRunning: 8 }, () => NOW)).go).toBe(true);
    });

    it("lets the first child go even where no account carries it, on the one that holds out longest", async () => {
        const full = [claude("radarsu", 90, 4, 55), claude("artur", 80, 4, 71)];
        expect(await claimBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: full, childId: "sub-a", childrenRunning: 0 }, () => NOW)).toMatchObject({ go: true, account: "artur", short: true });
        expect((await claimBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: full, childId: "sub-b", childrenRunning: 1 }, () => NOW)).go).toBe(false);
    });

    it("never holds a child with the budget switched off, but still places it", async () => {
        const full = [claude("radarsu", 90, 4, 55), claude("artur", 80, 4, 71)];
        expect(await claimBudget(deps({ subagentBudget: false }), { provider: "claude", model: "claude-opus-5-5", readings: full, childId: "sub-a", childrenRunning: 5 }, () => NOW)).toMatchObject({ go: true, account: "artur" });
    });

    it("judges a routed provider's ready accounts as one pool, placing nothing", async () => {
        const codex = [claude("codex-a.json", 50, 2, 10), claude("codex-b.json", 100, 2, 10)];
        const claim = await claimBudget(deps(), { provider: "codex", model: "gpt-6.1-sol", readings: codex, childId: "sub-c", childrenRunning: 0 }, () => NOW);
        expect(claim).toMatchObject({ go: true });
        expect(claim.go ? claim.account : "held").toBeUndefined();
    });

    it("forecasts how many more children fit and picks where a moved turn lands", async () => {
        const forecast = await forecastBudget(deps(), { provider: "claude", model: "claude-opus-5-5", readings: READINGS }, NOW);
        expect(forecast?.more).toBe(9);
        expect(await pickAccount(deps(), { provider: "claude", model: "claude-opus-5-5", readings: READINGS, refused: "artur" })).toBe("radarsu");
    });

    // 2026-11-08: Google meters Claude and GPT apart from Gemini, and each pool ran out under its own load. A Gemini child
    // is priced by the Gemini pool's run-out, never by how fast the Claude pool went.
    it("prices a window by its own pool's last run-out, never another pool's of the same provider", async () => {
        const pools = (account: string): ServiceFacts => ({
            account,
            usage: {
                windows: [
                    { kind: "google:models:claude", label: "Claude and GPT models", utilization: 20, gates: { models: ["claude", "gpt"] } },
                    { kind: "google:models:gemini", label: "Gemini models", utilization: 20, gates: { models: ["gemini"] } },
                ],
                measuredAt: NOW,
            },
        });
        // The Claude pool went in an hour under ten agents; the Gemini pool lasted a hundred hours under two.
        const claudePool: RunOut = { at: NOW - 3_600_000, openedAt: NOW - 2 * 3_600_000, pool: "Claude and GPT models", kind: "google:models:claude", models: { "claude-opus-5-5": 10 } };
        const geminiPool: RunOut = { at: NOW - 60_000, openedAt: NOW - 60_000 - 100 * 3_600_000, pool: "Gemini models", kind: "google:models:gemini", models: { "gemini-3-flash": 2 } };
        const priced = async (runOuts: RunOuts) => {
            const forecast = await forecastBudget({ ...deps(), runOuts: { read: async () => runOuts, record: async () => {} } }, { provider: "gemini", model: "gemini-3-flash", readings: [pools("g1.json")] }, NOW);
            return forecast?.plan.accounts[0]?.windows.map((window) => [window.kind, window.tokensPerPoint]);
        };
        // A window with no length named prices a point at one per agent hour; the Gemini pool's run-out says half that.
        expect(await priced({ "gemini:google:models:claude": claudePool, "gemini:google:models:gemini": geminiPool })).toEqual([["google:models:gemini", 18 * M]]);
        // A file written before 2026-11-08 keeps one record per provider, matched by the pool's name.
        const { kind: _kind, ...unkeyed } = geminiPool;
        expect(await priced({ gemini: unkeyed })).toEqual([["google:models:gemini", 18 * M]]);
        expect(await priced({ gemini: claudePool })).toEqual([["google:models:gemini", 9 * M]]);
    });
});
