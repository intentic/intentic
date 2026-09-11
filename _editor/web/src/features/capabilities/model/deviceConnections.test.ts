import type { Device } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { deviceConnections, isDeviceConnection } from "./deviceConnections";

// The gap this closes: a machine reached only by desktop sync is a real, live device, and Capabilities used to show
// no trace of it while the Devices board showed it as live. Both now read the same list.

const NOW = 1_700_000_000_000;

const report = (overrides: Partial<NonNullable<Device[`report`]>> = {}): Device[`report`] => ({
    hostname: `radarsu-rog`,
    os: `linux`,
    sandboxes: [],
    pairings: [],
    ports: [],
    agent: { running: true, installed: `1.252.0` },
    capturedAt: NOW,
    ...overrides,
});

// A machine that arrived through the sync door alone: an enrollment, a report, and no capability behind it.
const synced = (overrides: Partial<Device> = {}): Device => ({
    key: `radarsu-rog`,
    label: `radarsu-rog`,
    sync: { machine: `radarsu-rog`, mode: `sync`, seenAt: NOW },
    platform: `linux`,
    report: report(),
    ...overrides,
});

test(`lists a sync-only machine on the card it would be connected on`, () => {
    const [row] = deviceConnections([synced()], NOW);
    expect(row).toMatchObject({ cardId: `linux`, title: `radarsu-rog`, machine: `radarsu-rog`, note: `no command access` });
    expect(isDeviceConnection(row?.id ?? ``)).toBe(true);
});

// The whole point of reading one list: the word and the colour beside a machine must not depend on which screen
// asked. `live` here is the same verdict deviceState gives the board.
test(`states the machine exactly as the Devices board states it`, () => {
    expect(deviceConnections([synced()], NOW)[0]).toMatchObject({ state: `live`, tone: `success`, rank: 3 });
    const stalled = synced({ report: report({ agent: { running: false, installed: `1.252.0` } }) });
    expect(deviceConnections([stalled], NOW)[0]).toMatchObject({ state: `needs attention`, tone: `warning`, rank: 1 });
});

test(`says which OS it is, and its hostname only when that is not already the name`, () => {
    expect(deviceConnections([synced()], NOW)[0]?.detail).toBe(`Linux`);
    const renamed = synced({ label: `work-laptop` });
    expect(deviceConnections([renamed], NOW)[0]?.detail).toBe(`Linux · radarsu-rog`);
});

// WSL is the case that made this worth stating on the row: the distro and the Windows install hosting it arrive
// under one hostname, on two different cards.
test(`names the WSL distro, so two cards' rows are told apart`, () => {
    const distro = synced({ report: report({ wsl: { distro: `Arch` } }) });
    expect(deviceConnections([distro], NOW)[0]?.detail).toBe(`Arch on WSL`);
});

test(`leaves out machines a card already accounts for`, () => {
    // Connected as a device: the card lists it the ordinary way, as an instance of itself.
    expect(deviceConnections([synced({ hostId: `radarsu-rog`, online: true })], NOW)).toEqual([]);
    // Reached only by a host capability, never enrolled for sync: likewise already a connection.
    expect(deviceConnections([{ key: `omen`, label: `omen`, hostId: `omen`, online: true, platform: `windows` }], NOW)).toEqual([]);
});

// No card exists for it, so there is nowhere for the row to lead; the Devices board stays the place every machine
// appears whatever it runs.
test(`leaves out a machine whose platform has no card`, () => {
    expect(deviceConnections([synced({ platform: `macos` })], NOW)).toEqual([]);
    expect(deviceConnections([synced({ platform: undefined })], NOW)).toEqual([]);
});
