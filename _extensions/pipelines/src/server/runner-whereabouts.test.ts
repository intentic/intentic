import { unstubbed } from "@intentic/testing";
import type { CiFleet, CiRunner, Device, PipelinesDaemon } from "./daemon.js";
import { resetRunnerWhereabouts, runnerWhereabouts, whereaboutsWords } from "./runner-whereabouts.js";

// Which connected computer has a runner, for the notice a fleet failure sends: who is asked, what is remembered, and
// that a computer that cannot answer is one that does not have it, never a failure. Asked through the daemon's device
// routes (GET /system/devices, GET /system/devices/{id}/ci-runners).

interface Door {
    readonly features?: readonly string[];
    readonly distro?: string;
    readonly answer: () => Promise<string>;
}

const RUNNER: CiRunner = {
    name: "radarsu-worker-3",
    unit: "actions.runner.acme-web.radarsu-worker-3.service",
    dir: "/home/radarsu/actions-runner-3",
    user: "radarsu",
    url: "https://github.com/acme/web",
    version: "2.329.0",
    light: false,
    state: "active",
    busy: false,
    draining: false,
};

const FLEET: CiFleet = {
    service: { running: true, installed: true, version: "0.42.0" },
    runners: [RUNNER],
    cacheRoot: "/ci-cache",
    caches: [{ name: "pnpm-store", bytes: 4_000_000_000 }],
};

const hub = (doors: Readonly<Record<string, Door>>) => {
    const asked: string[] = [];
    const daemon = unstubbed<PipelinesDaemon>("daemon", {
        devices: async () =>
            Object.entries(doors).map(([id, door]): Device =>
                unstubbed<Device>("device", {
                    hostId: id,
                    online: true,
                    facts: unstubbed<NonNullable<Device["facts"]>>("facts", {
                        features: [...(door.features ?? ["ci-runners"])],
                        wsl: door.distro === undefined ? undefined : { distro: door.distro },
                    }),
                }),
            ),
        ciFleet: async (id) => {
            asked.push(`${id} ci_runners`);
            // SAFETY: what the machine answered, as the daemon's relay parses it; a test hands only fleets or nonsense.
            return JSON.parse(await (doors[id]?.answer ?? (async () => ""))()) as CiFleet;
        },
    });
    return { daemon, asked };
};

const holding = (fleet: CiFleet) => async () => JSON.stringify(fleet);
const OTHER: CiFleet = { ...FLEET, runners: [{ ...RUNNER, name: "z440-worker-1", unit: "actions.runner.acme-web.z440-worker-1.service" }] };

beforeEach(() => resetRunnerWhereabouts());

test("the computer that has the runner is named with its distro, and one that does not read its runners is never asked", async () => {
    const { daemon, asked } = hub({
        z440: { answer: holding(OTHER) },
        rog: { features: ["stacks"], answer: holding(FLEET) },
        omen: { distro: "archlinux", answer: holding(FLEET) },
    });
    const found = await runnerWhereabouts(daemon, RUNNER.name);
    expect(found).toEqual({ device: "omen (archlinux)", runner: RUNNER });
    expect(asked.toSorted()).toEqual(["omen ci_runners", "z440 ci_runners"]);
    expect(found === undefined ? undefined : whereaboutsWords(found)).toBe("radarsu-worker-3 on omen (archlinux), actions.runner.acme-web.radarsu-worker-3.service, active");
});

test("a runner held down says why", () => {
    expect(whereaboutsWords({ device: "z440", runner: { ...RUNNER, state: "inactive", held: "drain" } })).toBe(
        "radarsu-worker-3 on z440, actions.runner.acme-web.radarsu-worker-3.service, inactive (held down: drain)",
    );
});

test("a computer that fails, answers something else or has no such runner is one that does not have it", async () => {
    const { daemon } = hub({
        omen: {
            answer: async () => {
                throw new Error("WebSocket is not open");
            },
        },
        z440: { answer: async () => "systemctl: command not found" },
        inwin: { answer: holding(OTHER) },
    });
    expect(await runnerWhereabouts(daemon, RUNNER.name)).toBeUndefined();
});

test("a computer's answer serves every job judged in the next few minutes, and is asked again after", async () => {
    const { daemon, asked } = hub({ omen: { answer: holding(FLEET) } });
    const now = Date.parse("2026-11-24T10:00:00Z");
    await Promise.all([runnerWhereabouts(daemon, RUNNER.name, now), runnerWhereabouts(daemon, "z440-worker-1", now)]);
    await runnerWhereabouts(daemon, RUNNER.name, now + 60_000);
    expect(asked).toEqual(["omen ci_runners"]);
    await runnerWhereabouts(daemon, RUNNER.name, now + 4 * 60_000);
    expect(asked).toEqual(["omen ci_runners", "omen ci_runners"]);
});
