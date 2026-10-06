import { AGENT_STALL_AFTER_MS, DEV_VERSION, type DeviceAgent } from "@intentic/sandbox-contract";
import type { DeviceStatus } from "./desktop";
import { desktopAgentPanel } from "./deviceAgent";

// The desktop's agent block is judged by the contract's rules (agentStalled, agentBuildSkew), the ones the web Devices
// tab and `intentic-machine status` apply. Before, this app re-implemented the skew and never read `lastTickAt`, so an
// agent whose loop had died read "running" here while the web said "stalled".

const CAPTURED_AT = 1_790_000_000_000;

const statusWith = (agent: DeviceAgent): DeviceStatus => ({
    version: `1.318.0`,
    summary: `1 sandbox connected`,
    device: { links: [] },
    sync: { hostname: `rog`, os: `windows`, pairings: [], ports: [], agent, capturedAt: CAPTURED_AT },
});

const live = { running: true, pid: 8984, installed: `1.318.0`, build: `1.318.0` } as const;

describe(`desktopAgentPanel`, () => {
    it(`says nothing for a device with no agent`, () => {
        expect(desktopAgentPanel(undefined)).toBeUndefined();
    });

    it(`reads an agent whose last pass is older than the stall window as stalled, not running`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, lastTickAt: CAPTURED_AT - AGENT_STALL_AFTER_MS - 1 }));
        expect(panel?.state).toEqual({ word: `stalled`, variant: `warning` });
        expect(panel?.notes.map((note) => note.tone)).toEqual([`warning`]);
        expect(panel?.notes[0]?.text).toBe(`Agent stalled — what is below may be out of date.`);
    });

    it(`reads an agent at the edge of the stall window as running`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, lastTickAt: CAPTURED_AT - AGENT_STALL_AFTER_MS }));
        expect(panel?.state).toEqual({ word: `running`, variant: `success` });
    });

    // An agent too old to stamp a tick, or one whose first pass hasn't finished, is not evidence of a stall.
    it(`reads an agent that reports no pass yet as running`, () => {
        expect(desktopAgentPanel(statusWith(live))?.state).toEqual({ word: `running`, variant: `success` });
    });

    it(`judges a stall on the reading's own clock, not on the time it is drawn`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, lastTickAt: CAPTURED_AT - 1_000 }));
        expect(panel?.state).toEqual({ word: `running`, variant: `success` });
    });

    it(`reads a stopped agent as stopped, whatever its last pass`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, running: false, lastTickAt: 0 }));
        expect(panel?.state).toEqual({ word: `stopped`, variant: `warning` });
        expect(panel?.notes.map((note) => note.text)).toEqual([`Agent stopped — nothing reaches its folders or ports.`]);
    });

    it(`says the build skew the contract finds, for a process serving an older build than the one installed`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, build: `1.317.0` }));
        expect(panel?.notes.map((note) => note.text)).toEqual([`Serving 1.317.0, 1.318.0 installed — a restart picks it up.`]);
    });

    it(`says an unstamped running build is older than the one installed`, () => {
        const { build: _, ...unstamped } = live;
        const panel = desktopAgentPanel(statusWith(unstamped));
        expect(panel?.notes.map((note) => note.text)).toEqual([`Serving a build older than the 1.318.0 installed — a restart picks it up.`]);
    });

    // The contract's DEV_VERSION, not a copy of its value: a working-tree install is never stale.
    it(`finds no skew on a working-tree install`, () => {
        const panel = desktopAgentPanel(statusWith({ ...live, installed: DEV_VERSION, build: `1.317.0` }));
        expect(panel?.notes.map((note) => note.tone)).toEqual([undefined]);
        expect(panel?.facts).toEqual([`pid 8984`]);
        expect(panel?.actions.map((action) => action.op)).toEqual([`restart`]);
    });
});
