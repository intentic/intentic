import type { CiFleet } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { FLEET, RUNNER } from "./device-ci-fleet.testing.js";
import { resetRunnerWhereabouts, runnerWhereabouts, whereaboutsWords, type WhereaboutsServices } from "./runner-whereabouts.js";

// Which connected computer has a runner, for the notice a fleet failure sends: who is asked, what is remembered, and
// that a computer that cannot answer is one that does not have it, never a failure.

interface Door {
    readonly features?: readonly string[];
    readonly distro?: string;
    readonly answer: () => Promise<string>;
}

const FACTS: DeviceFacts = { os: "Arch Linux", arch: "x64", shell: "zsh", home: "/home/me", roots: ["/home/me"] };
const ToolRequestSchema = z.object({ params: z.object({ name: z.string() }) });

const hub = (doors: Readonly<Record<string, Door>>) => {
    const asked: string[] = [];
    const services: WhereaboutsServices = {
        hostHub: unstubbed<WhereaboutsServices["hostHub"]>("hostHub", {
            connected: () => Object.keys(doors),
            state: (id) => {
                const door = doors[id];
                const facts = { ...FACTS, features: [...(door?.features ?? ["ci-runners"])] };
                return { online: true, facts: door?.distro === undefined ? facts : { ...facts, wsl: { distro: door.distro } } };
            },
            mcp: async (id, payload) => {
                asked.push(`${id} ${ToolRequestSchema.parse(payload).params.name}`);
                const text = await (doors[id]?.answer ?? (async () => ""))();
                return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } };
            },
        }),
    };
    return { services, asked };
};

const holding = (fleet: CiFleet) => async () => JSON.stringify(fleet);
const OTHER: CiFleet = { ...FLEET, runners: [{ ...RUNNER, name: "z440-worker-1", unit: "actions.runner.acme-web.z440-worker-1.service" }] };

beforeEach(() => resetRunnerWhereabouts());

test("the computer that has the runner is named with its distro, and one that does not read its runners is never asked", async () => {
    const { services, asked } = hub({
        z440: { answer: holding(OTHER) },
        rog: { features: ["stacks"], answer: holding(FLEET) },
        omen: { distro: "archlinux", answer: holding(FLEET) },
    });
    const found = await runnerWhereabouts(services, RUNNER.name);
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
    const { services } = hub({
        omen: {
            answer: async () => {
                throw new Error("WebSocket is not open");
            },
        },
        z440: { answer: async () => "systemctl: command not found" },
        inwin: { answer: holding(OTHER) },
    });
    expect(await runnerWhereabouts(services, RUNNER.name)).toBeUndefined();
});

test("a computer's answer serves every job judged in the next few minutes, and is asked again after", async () => {
    const { services, asked } = hub({ omen: { answer: holding(FLEET) } });
    const now = Date.parse("2026-11-24T10:00:00Z");
    await Promise.all([runnerWhereabouts(services, RUNNER.name, now), runnerWhereabouts(services, "z440-worker-1", now)]);
    await runnerWhereabouts(services, RUNNER.name, now + 60_000);
    expect(asked).toEqual(["omen ci_runners"]);
    await runnerWhereabouts(services, RUNNER.name, now + 4 * 60_000);
    expect(asked).toEqual(["omen ci_runners", "omen ci_runners"]);
});
