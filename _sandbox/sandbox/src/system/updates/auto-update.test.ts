import type { DeviceFlowLine, DeviceSandboxFlow, StagedUpdate } from "@intentic/sandbox-contract";
import { waitFor } from "@intentic/testing/bun";
import type { RestartResume } from "../restart-resume.js";
import {
    type AutoUpdateActivity,
    type AutoUpdateOffer,
    type AutoUpdater,
    createAutoUpdater,
    holdsOf,
    SCHEDULE_LEAD_MS,
    TERMINAL_PATIENCE_MS,
    TERMINAL_QUIET_MS,
    takeableVersion,
} from "./auto-update.js";
import type { UpdatePolicy, UpdatePolicyFile } from "./update-policy.js";

// The restart an update costs is taken by itself only at a moment nobody would feel it: never under an agent mid-turn
// or a person at the editor, counted down so anyone still connected can see it coming, and handed to the machine exactly
// as the Update button hands it, with the next boot asked to pick up whatever it still cuts.

const STAGED: StagedUpdate = { version: "1.5.0", channel: "stable", at: 1 };
const offer = (over: Partial<AutoUpdateOffer> = {}): AutoUpdateOffer => ({
    running: "1.4.0",
    staged: STAGED,
    preparing: false,
    latest: "1.5.0",
    skipped: undefined,
    givenUp: undefined,
    breaking: false,
    ...over,
});
const QUIET: AutoUpdateActivity = { working: [], people: [], connected: 0, terminalAt: 0, dueAt: 0 };

describe("takeableVersion", () => {
    test("takes a downloaded release newer than what runs", () => {
        expect(takeableVersion(offer())).toBe("1.5.0");
        // Tags and versions are compared without the tag's `v`.
        expect(takeableVersion(offer({ staged: { ...STAGED, version: "v1.5.0" }, running: "v1.4.0" }))).toBe("1.5.0");
    });

    test("a download that did not name itself is the release on offer", () => {
        const { version: _unnamed, ...unnamed } = STAGED;
        expect(takeableVersion(offer({ staged: unnamed }))).toBe("1.5.0");
        expect(takeableVersion(offer({ staged: unnamed, latest: undefined }))).toBeUndefined();
    });

    test("takes nothing it should leave to a person", () => {
        // Nothing downloaded: an update that still has to download is minutes of downtime.
        expect(takeableVersion(offer({ staged: undefined }))).toBeUndefined();
        // Its own pre-flight refused this sandbox's files.
        expect(takeableVersion(offer({ staged: { ...STAGED, plan: { ok: false } } }))).toBeUndefined();
        // The owner skipped it.
        expect(takeableVersion(offer({ skipped: "1.5.0" }))).toBeUndefined();
        // A newer release overtook it: the swap would pull the moved tag and download after all.
        expect(takeableVersion(offer({ latest: "1.6.0" }))).toBeUndefined();
        // The machine is downloading again right now.
        expect(takeableVersion(offer({ preparing: true }))).toBeUndefined();
        // Nothing newer than what runs, or a build that does not know what it runs.
        expect(takeableVersion(offer({ running: "1.5.0" }))).toBeUndefined();
        expect(takeableVersion(offer({ running: undefined }))).toBeUndefined();
    });

    test("never the version the machine just tried and gave up on, which a newer release replaces", () => {
        // ic put the previous version back (restored, or rolled back by its probation watch) and left the staged marker:
        // this daemon is the restored one, and taking it again would restart the sandbox into the same failure.
        expect(takeableVersion(offer({ givenUp: "1.5.0" }))).toBeUndefined();
        expect(takeableVersion(offer({ givenUp: "v1.5.0" }))).toBeUndefined();
        const next: StagedUpdate = { version: "1.6.0", channel: "stable", at: 2 };
        expect(takeableVersion(offer({ givenUp: "1.5.0", staged: next, latest: "1.6.0" }))).toBe("1.6.0");
    });
});

describe("holdsOf", () => {
    const now = 10 * 24 * 60 * 60_000;
    const facts = { activity: QUIET, breaking: false, pausedUntil: undefined, host: "rog", retryAt: undefined, waitingSince: now, now };

    test("a quiet sandbox on a connected machine holds nothing", () => {
        expect(holdsOf(facts)).toEqual([]);
    });

    test("names everything that holds it, the longest-lasting first", () => {
        expect(
            holdsOf({
                ...facts,
                breaking: true,
                pausedUntil: now + 1_000,
                host: undefined,
                retryAt: now + 2_000,
                activity: { working: ["LEDGERLY"], people: ["Ada"], connected: 2, terminalAt: now - 1_000, dueAt: now + 60_000 },
            }).map((hold) => hold.kind),
        ).toEqual(["consent", "paused", "machine", "retry", "agents", "people", "schedule", "terminal"]);
    });

    test("a pause or a retry already past holds nothing", () => {
        expect(holdsOf({ ...facts, pausedUntil: now - 1, retryAt: now - 1 })).toEqual([]);
    });

    test("an automation is waited for only when it is due soon", () => {
        expect(holdsOf({ ...facts, activity: { ...QUIET, dueAt: now + SCHEDULE_LEAD_MS } })).toEqual([{ kind: "schedule", until: now + SCHEDULE_LEAD_MS }]);
        expect(holdsOf({ ...facts, activity: { ...QUIET, dueAt: now + SCHEDULE_LEAD_MS + 1 } })).toEqual([]);
    });

    test("a busy terminal holds it for a day of waiting, never longer", () => {
        const busy = { ...QUIET, terminalAt: now - 60_000 };
        expect(holdsOf({ ...facts, activity: busy })).toEqual([{ kind: "terminal", until: now - 60_000 + TERMINAL_QUIET_MS }]);
        expect(holdsOf({ ...facts, activity: { ...QUIET, terminalAt: now - TERMINAL_QUIET_MS } })).toEqual([]);
        expect(holdsOf({ ...facts, activity: busy, waitingSince: now - TERMINAL_PATIENCE_MS })).toEqual([]);
    });
});

describe("createAutoUpdater", () => {
    let activity: AutoUpdateActivity = QUIET;
    let current: AutoUpdateOffer = offer();
    let host: string | undefined = "rog";
    let policy: UpdatePolicy = {};
    let answer: DeviceFlowLine[] = [];
    let relayed: { host: string; flow: DeviceSandboxFlow }[] = [];
    let asks: string[] = [];
    let changes = 0;
    let updater: AutoUpdater | undefined;

    const policyFile: UpdatePolicyFile = {
        read: async () => policy,
        setAuto: async (on) => {
            policy = on ? (({ auto: _auto, ...rest }) => rest)(policy) : { ...policy, auto: false };
        },
        pause: async (until) => {
            policy = until === undefined ? (({ pausedUntil: _paused, ...rest }) => rest)(policy) : { ...policy, pausedUntil: until };
        },
        applied: async (applied) => {
            policy = applied === undefined ? (({ applied: _applied, ...rest }) => rest)(policy) : { ...policy, applied };
        },
    };
    const restartResume: RestartResume = {
        ask: async () => {
            asks.push("ask");
        },
        withdraw: async () => {
            asks.push("withdraw");
        },
        take: async () => false,
    };

    const make = (): AutoUpdater => {
        updater = createAutoUpdater({
            offer: async () => current,
            activity: async () => activity,
            policy: policyFile,
            host: async () => host,
            async *relay(to, flow) {
                relayed.push({ host: to, flow });
                yield* answer;
            },
            restartResume,
            slug: "work",
            changed: () => {
                changes += 1;
            },
            logger: { info: () => undefined, warn: () => undefined },
            pollMs: 5,
            // Long enough that a loaded runner still looks inside a countdown (20 ms ran out between two 15 ms ticks on
            // CI); a test waiting for one to end polls for it rather than sleeping a guess.
            countdownMs: { seen: 600, unseen: 300 },
            cutoverGraceMs: 10_000,
        });
        return updater;
    };

    const tick = async (ms = 15): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    };

    afterEach(() => {
        updater?.stop();
        updater = undefined;
        activity = QUIET;
        current = offer();
        host = "rog";
        policy = {};
        answer = [];
        relayed = [];
        asks = [];
        changes = 0;
    });

    test("waits while agents work and somebody is at the editor, naming both, and touches nothing", async () => {
        activity = { ...QUIET, working: ["LEDGERLY"], people: ["Ada"], connected: 1 };
        const auto = make();
        await tick(40);
        expect(relayed).toEqual([]);
        expect(await auto.state()).toEqual({
            enabled: true,
            phase: "waiting",
            version: "1.5.0",
            holds: [
                { kind: "agents", names: ["LEDGERLY"] },
                { kind: "people", names: ["Ada"] },
            ],
        });
        expect(changes).toBeGreaterThan(0);
    });

    test("once nothing holds it, counts down and hands the machine the same update the button sends", async () => {
        activity = { ...QUIET, working: ["LEDGERLY"] };
        const auto = make();
        await tick();
        expect((await auto.state()).phase).toBe("waiting");

        activity = QUIET;
        const counting = await waitFor(
            async () => {
                const state = await auto.state();
                expect(state.phase).toBe("countdown");
                return state;
            },
            { interval: 5 },
        );
        expect(counting.startsAt).toBeGreaterThan(Date.now());
        expect(relayed).toEqual([]);

        await waitFor(() => expect(relayed).toEqual([{ host: "rog", flow: { op: "update", slug: "work" } }]), { timeout: 3_000, interval: 10 });
        // The stream dying at the cutover never lets this process withdraw the ask: the next boot resumes what it cut.
        await waitFor(() => expect(asks).toEqual(["ask"]), { interval: 5 });
        expect((await auto.state()).phase).toBe("updating");
        expect(policy.applied?.to).toBe("1.5.0");
    });

    test("a countdown somebody could see is longer, and stops the moment they come back to the editor", async () => {
        activity = { ...QUIET, connected: 1 };
        const auto = make();
        await tick();
        expect((await auto.state()).phase).toBe("countdown");

        activity = { ...QUIET, connected: 1, people: ["Ada"] };
        auto.poke();
        await tick(1_100);
        expect(await auto.state()).toMatchObject({ phase: "waiting", holds: [{ kind: "people", names: ["Ada"] }] });
        expect(relayed).toEqual([]);
    });

    test("the version the machine just gave up on is not handed to it again by the daemon it restored", async () => {
        current = offer({ givenUp: "1.5.0" });
        const auto = make();
        await tick(60);
        expect(relayed).toEqual([]);
        expect(await auto.state()).toEqual({ enabled: true, phase: "idle", holds: [] });
    });

    test("switched off, it waits on nothing and takes nothing", async () => {
        policy = { auto: false };
        const auto = make();
        await tick(60);
        expect(relayed).toEqual([]);
        expect(await auto.state()).toEqual({ enabled: false, phase: "idle", holds: [] });
    });

    test("a release that changes what developers build on waits for a person, however quiet it is", async () => {
        current = offer({ breaking: true });
        const auto = make();
        await tick(60);
        expect(relayed).toEqual([]);
        expect(await auto.state()).toMatchObject({ phase: "waiting", holds: [{ kind: "consent" }] });
    });

    test("a machine that answers in words did not restart anything: said, and tried again later", async () => {
        answer = [{ kind: "error", message: "Not enough free disk space for the update." }];
        const auto = make();
        // Settled once the next look has read the failure back as a hold: until then the state is the failure alone.
        const state = await waitFor(
            async () => {
                const said = await auto.state();
                expect({ failure: said.failure, holds: said.holds.map((hold) => hold.kind) }).toEqual({
                    failure: "Not enough free disk space for the update.",
                    holds: ["retry"],
                });
                return said;
            },
            { timeout: 3_000, interval: 10 },
        );
        expect(relayed).toHaveLength(1);
        expect(state.phase).toBe("waiting");
        // No update of ours is coming, so the next boot must not claim one, nor resume turns for it.
        expect(policy.applied).toBeUndefined();
        expect(asks).toEqual(["ask", "withdraw"]);
    });

    test("an unconnected machine is waited for, and named", async () => {
        host = undefined;
        const auto = make();
        await tick(40);
        expect(await auto.state()).toMatchObject({ phase: "waiting", holds: [{ kind: "machine" }] });
        expect(relayed).toEqual([]);
    });

    test("the owner's pause holds it until its moment, and lifting it lets it go", async () => {
        activity = { ...QUIET, working: ["LEDGERLY"] };
        const auto = make();
        const until = Date.now() + 60 * 60_000;
        const paused = await auto.configure({ pausedUntil: until });
        expect(paused.pausedUntil).toBe(until);
        expect(paused.holds[0]).toEqual({ kind: "paused", until });

        const lifted = await auto.configure({ pausedUntil: null });
        expect(lifted.pausedUntil).toBeUndefined();
        expect(lifted.holds.map((hold) => hold.kind)).toEqual(["agents"]);
    });

    test("now, from the owner, skips the wait and the countdown", async () => {
        activity = { ...QUIET, working: ["LEDGERLY"], people: ["Ada"] };
        const auto = make();
        await tick();
        const state = await auto.configure({ applyNow: true });
        expect(state.phase).toBe("updating");
        await tick();
        expect(relayed).toEqual([{ host: "rog", flow: { op: "update", slug: "work" } }]);
    });

    test("now, with nothing downloaded, says so", async () => {
        current = offer({ staged: undefined });
        const auto = make();
        await expect(auto.configure({ applyNow: true })).rejects.toThrow("no downloaded update");
    });

    test("the version that comes up reads back that it was taken by itself", async () => {
        current = offer({ running: "1.5.0" });
        policy = { applied: { at: 42, to: "1.5.0" } };
        const auto = make();
        await tick();
        expect(await auto.state()).toEqual({ enabled: true, phase: "idle", holds: [], lastApplied: { at: 42, to: "1.5.0" } });
    });

    test("an update that never came up is not read back as one taken", async () => {
        policy = { applied: { at: 42, to: "1.5.0" } };
        current = offer({ running: "1.4.0", staged: undefined });
        const auto = make();
        await tick();
        expect((await auto.state()).lastApplied).toBeUndefined();
    });
});
