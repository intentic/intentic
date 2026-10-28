import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { type ChildPlacementAsk, placeChild } from "./child-placement.js";

const omen: RunnerSummary = { id: "omen", online: true, parity: "current", facts: { cpus: 16, memoryMb: 24_000, freeDiskMb: 100_000, load: 0.1 } };
const asleep: RunnerSummary = { id: "laptop", online: false, parity: "current" };
const idle = { inFlight: new Map<string, number>() };
const ask = (over: Partial<ChildPlacementAsk> = {}): ChildPlacementAsk => ({
    on: "omen",
    providerLabel: "Claude Code",
    travels: true,
    claudeCodeLoop: true,
    shieldHolds: false,
    ...over,
});

describe("where a spawned child runs", () => {
    it("runs on the runner it was asked onto, and says so", () => {
        expect(placeChild(ask(), [omen], idle)).toEqual({ kind: "runner", runner: "omen", note: `Running on the runner "omen".` });
    });

    // 2026-10-28: a Claude child asked onto omen ran here in silence, the shield having kept it home.
    it("refuses a named runner the privacy shield keeps the provider off, naming the way out", () => {
        const verdict = placeChild(ask({ shieldHolds: true }), [omen], idle);
        expect(verdict).toMatchObject({ kind: "refused" });
        expect(verdict.kind === "refused" && verdict.message).toContain(`on: "here"`);
    });

    // 2026-10-28: Codex on omen started, then failed with "Connect your ChatGPT subscription", which was connected.
    it("refuses a harness whose sign-in cannot travel, offering the Claude Code harness where the provider has it", () => {
        const verdict = placeChild(ask({ providerLabel: "Codex", travels: false }), [omen], idle);
        expect(verdict.kind === "refused" && verdict.message).toContain(`harness: "claude-code"`);
        const devin = placeChild(ask({ providerLabel: "Devin", travels: false, claudeCodeLoop: false }), [omen], idle);
        expect(devin.kind === "refused" && devin.message).not.toContain("claude-code");
    });

    it("refuses a runner that is offline or unknown, listing the ones there are", () => {
        expect(placeChild(ask({ on: "laptop" }), [omen, asleep], idle)).toMatchObject({ kind: "refused" });
        const unknown = placeChild(ask({ on: "omne" }), [omen, asleep], idle);
        expect(unknown.kind === "refused" && unknown.message).toContain(`"omen", "laptop" (offline)`);
    });

    it("leaves a child nobody placed to the fleet, and keeps one the shield holds here", () => {
        expect(placeChild(ask({ on: undefined }), [omen], idle)).toMatchObject({ kind: "runner", runner: "omen" });
        expect(placeChild(ask({ on: undefined, shieldHolds: true }), [omen], idle)).toEqual({ kind: "here", note: "Running here, in this sandbox." });
        expect(placeChild(ask({ on: undefined }), [], idle)).toEqual({ kind: "here" });
        expect(placeChild(ask({ on: "here" }), [omen], idle)).toEqual({ kind: "here" });
    });
});
