import type { RunnerFacts, RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { type ChildFleet, type ChildPlacementAsk, placeChild, roomContested } from "./child-placement.js";
import { fleetMachine, machineLoad } from "./fleet-advice.js";

const omen: RunnerSummary = { id: "omen", online: true, parity: "current", facts: { cpus: 16, memoryMb: 24_000, freeDiskMb: 100_000, load: 0.1 } };
const asleep: RunnerSummary = { id: "laptop", online: false, parity: "current" };
const ask = (over: Partial<ChildPlacementAsk> = {}): ChildPlacementAsk => ({
    on: "omen",
    providerLabel: "Claude Code",
    travels: true,
    claudeCodeLoop: true,
    shieldHolds: false,
    ...over,
});

// An eight-core machine with nothing running: six slots, plenty of memory, quiet CPUs.
const quiet = (overrides: Partial<RunnerFacts> = {}): RunnerFacts => ({
    cpus: 8,
    memoryMb: 32_768,
    freeDiskMb: 100_000,
    load: 0.1,
    memoryFreeMb: 28_000,
    ...overrides,
});
const CALM_HERE = machineLoad(quiet({ cpus: 16 }), 0);
const BUSY_HERE = machineLoad(quiet({ cpus: 16, load: 1 }), 0);
const FULL_HERE = machineLoad(quiet({ cpus: 16, memoryFreeMb: 500 }), 0);

const fleet = (here: ChildFleet["here"], ...runners: readonly [string, RunnerFacts, number?][]): ChildFleet => ({
    here,
    machines: runners.map(([id, facts, agents]) =>
        fleetMachine({ id, name: id, online: true, facts, agents: agents ?? 0 }, { areas: false, shielded: false, travels: true }),
    ),
});

describe("a child its parent placed", () => {
    it("runs on the runner it was asked onto, and says so", () => {
        expect(placeChild(ask(), [omen], undefined)).toEqual({ kind: "runner", runner: "omen", note: `Running on the runner "omen".` });
        expect(placeChild(ask({ on: "here" }), [omen], fleet(FULL_HERE, ["omen", quiet()]))).toEqual({ kind: "here" });
    });

    // 2026-10-28: a Claude child asked onto omen ran here in silence, the shield having kept it home.
    it("refuses a named runner the privacy shield keeps the provider off, naming the way out", () => {
        const verdict = placeChild(ask({ shieldHolds: true }), [omen], undefined);
        expect(verdict).toMatchObject({ kind: "refused" });
        expect(verdict.kind === "refused" && verdict.message).toContain("Leave `on` out");
    });

    // 2026-10-28: Codex on omen started, then failed with "Connect your ChatGPT subscription", which was connected.
    it("refuses a harness whose sign-in cannot travel, offering the Claude Code harness where the provider has it", () => {
        const verdict = placeChild(ask({ providerLabel: "Codex", travels: false }), [omen], undefined);
        expect(verdict.kind === "refused" && verdict.message).toContain(`harness: "claude-code"`);
        const devin = placeChild(ask({ providerLabel: "Devin", travels: false, claudeCodeLoop: false }), [omen], undefined);
        expect(devin.kind === "refused" && devin.message).not.toContain("claude-code");
    });

    it("refuses a runner that is offline or unknown, listing the ones there are", () => {
        expect(placeChild(ask({ on: "laptop" }), [omen, asleep], undefined)).toMatchObject({ kind: "refused" });
        const unknown = placeChild(ask({ on: "omne" }), [omen, asleep], undefined);
        expect(unknown.kind === "refused" && unknown.message).toContain(`"omen", "laptop" (offline)`);
    });

    // 2026-11-09: 46 of 114 spawns pinned "here", whole fan-outs after one refusal had offered it as the way through.
    it("never offers pinning this sandbox as the way out of a refusal", () => {
        for (const refused of [
            placeChild(ask({ shieldHolds: true }), [omen], undefined),
            placeChild(ask({ providerLabel: "Codex", travels: false }), [omen], undefined),
            placeChild(ask({ on: "laptop" }), [omen, asleep], undefined),
            placeChild(ask({ on: "omne" }), [omen], undefined),
        ]) {
            expect(refused.kind === "refused" && refused.message).not.toContain(`"here"`);
        }
    });
});

describe("a child nobody placed", () => {
    it("stays here while this sandbox is calm, since moving it would cost a sync for nothing", () => {
        expect(placeChild(ask({ on: undefined }), [omen], fleet(CALM_HERE, ["omen", quiet()]))).toEqual({
            kind: "here",
            note: "Running here, in this sandbox, which has room.",
        });
    });

    it("goes to a calm runner while this sandbox is busy or full, naming the machine and the id to ask for later", () => {
        for (const here of [BUSY_HERE, FULL_HERE]) {
            expect(placeChild(ask({ on: undefined }), [omen], fleet(here, ["omen", quiet()]))).toMatchObject({ kind: "runner", runner: "omen" });
        }
        const named: ChildFleet = {
            here: FULL_HERE,
            machines: [fleetMachine({ id: "irt_1", name: "omen", online: true, facts: quiet(), agents: 0 }, { areas: false, shielded: false, travels: true })],
        };
        expect(placeChild(ask({ on: undefined }), [omen], named)).toEqual({
            kind: "runner",
            runner: "irt_1",
            note: `Running on omen (runner "irt_1"), which had more room than this sandbox.`,
        });
    });

    // A busy runner instead of a busy sandbox is a trade, not a relief.
    it("stays here when no runner is strictly better off, and says so", () => {
        const verdict = placeChild(ask({ on: undefined }), [omen], fleet(BUSY_HERE, ["omen", quiet({ load: 1 })]));
        expect(verdict).toEqual({ kind: "here", note: "Running here, in this sandbox, since no runner had more room." });
        // Six slots, six agents: as full as this sandbox.
        expect(placeChild(ask({ on: undefined }), [omen], fleet(FULL_HERE, ["omen", quiet(), 6]))).toMatchObject({ kind: "here" });
    });

    // A load average lags a minute behind; slots and memory do not.
    it("picks the runner with the most room, by a total order so equal machines never swap", () => {
        const roomier = fleet(FULL_HERE, ["busy", quiet({ load: 0.05 }), 4], ["free", quiet()]);
        expect(placeChild(ask({ on: undefined }), [omen], roomier)).toMatchObject({ runner: "free" });
        expect(placeChild(ask({ on: undefined }), [omen], fleet(FULL_HERE, ["b", quiet()], ["a", quiet()]))).toMatchObject({ runner: "a" });
    });

    it("keeps a child here that the shield holds or whose sign-in cannot travel, and says nothing on a fleetless sandbox", () => {
        const roomy = fleet(FULL_HERE, ["omen", quiet()]);
        expect(placeChild(ask({ on: undefined, shieldHolds: true }), [omen], roomy)).toEqual({ kind: "here", note: "Running here, in this sandbox." });
        expect(placeChild(ask({ on: undefined, travels: false }), [omen], roomy)).toEqual({ kind: "here", note: "Running here, in this sandbox." });
        expect(placeChild(ask({ on: undefined }), [], undefined)).toEqual({ kind: "here" });
    });
});

describe("contested runner room", () => {
    // Six slots, four taken: two left, the last ones a light child should leave to a heavy sibling.
    const tight = fleet(BUSY_HERE, ["omen", quiet(), 4]);

    it("is contested only while this sandbox is busy, not full, and the runner it would take is nearly out of slots", () => {
        expect(roomContested(ask({ on: undefined }), tight)).toBe(true);
        expect(roomContested(ask({ on: undefined }), fleet(BUSY_HERE, ["omen", quiet()]))).toBe(false);
        expect(roomContested(ask({ on: undefined }), fleet(FULL_HERE, ["omen", quiet(), 4]))).toBe(false);
        expect(roomContested(ask(), tight)).toBe(false);
    });

    it("keeps a light child here and sends a heavy or unsized one to the runner", () => {
        expect(placeChild(ask({ on: undefined, weight: "light" }), [omen], tight)).toMatchObject({ kind: "here", note: expect.stringContaining("light work") });
        expect(placeChild(ask({ on: undefined, weight: "heavy" }), [omen], tight)).toMatchObject({ kind: "runner", runner: "omen" });
        expect(placeChild(ask({ on: undefined }), [omen], tight)).toMatchObject({ kind: "runner", runner: "omen" });
        // Room to spare: a light child goes where the room is like any other.
        expect(placeChild(ask({ on: undefined, weight: "light" }), [omen], fleet(BUSY_HERE, ["omen", quiet()]))).toMatchObject({ kind: "runner" });
    });
});
