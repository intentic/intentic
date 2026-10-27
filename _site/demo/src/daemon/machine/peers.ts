import type { SyncStatus } from "@intentic/sandbox-contract/schemas/devices";
import type { PhoneSummary } from "@intentic/sandbox-contract/schemas/phone";
import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { RawJsonOutput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH } from "@intentic/sandbox-contract/schemas/short-codes";
import { refuse } from "@intentic/contract-serve";
import { demoDevices, switchDemoPairings } from "../../fixture/devices";
import { pause, pushDomains } from "./machineKit";

// The machines on the other end of this sandbox's doors (the daemon's hosts/, phones/, runners/, sync/): the desktop
// sync enrollment, the runners heavy work can go to, the phones paired to it, and the codes a command carries to enroll
// another. Each write changes what the next read says and pushes the domain the real daemon pushes, so every view that
// shows the machine moves with it.

const HOUR = 3_600_000;
const STARTED = Date.now();
// A pairing token lives ten minutes, in seconds as the wire says it.
const PAIRING_SECONDS = 600;
// How long after its code is shown the phone in the recording scans it: the time it takes to find a phone and point it.
const PHONE_SCANS_AFTER_MS = 9_000;
// Pushing settings over a runner's live link.
const RUNNER_SYNC_MS = 1_600;

/** A single-use short code in the contract's own alphabet, the 8 characters a command carries instead of a token. */
const shortCode = (): string =>
    Array.from(crypto.getRandomValues(new Uint8Array(SHORT_CODE_LENGTH)), (byte) => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join(``);

const token = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll(`-`, ``)}`;

// Desktop sync: the machines holding this sandbox's files, read off the devices fixture's own reports, so the badge,
// the Add device card and the Devices page agree about who syncs. A revoked key drops its machine here and its folder
// there.
const revokedMachines = new Set<string>();

const syncReports = (): NonNullable<SyncStatus[`machines`]> =>
    demoDevices(Date.now()).flatMap((device) =>
        device.report !== undefined && device.report.pairings.some((pairing) => pairing.sandboxId === `demo`) && !revokedMachines.has(device.report.hostname)
            ? [device.report]
            : [],
    );

export const syncStatus = (): SyncStatus => {
    const machines = syncReports();
    return { enrolled: machines.length > 0, syncing: machines.some((report) => report.pairings.some((pairing) => pairing.mode === `sync`)), available: true, machines };
};

/** A pairing for the Add device card's command; a mirror is what was asked when the card asks for one. */
export const syncPairing = (mirror: boolean): RawJsonOutput<`POST /system/sync/pair`> => ({
    token: token(`sync`),
    expiresIn: PAIRING_SECONDS,
    code: shortCode(),
    mode: mirror ? `mirror` : `sync`,
});

/** Drops one machine's sync key: its folder stops mirroring, as the machine notices on its next poll. */
export const revokeSyncMachine = (machine: string): RawJsonOutput<`DELETE /system/authorized-key/{machine}`> => {
    const held = demoDevices(Date.now()).filter((device) => device.report?.hostname === machine);
    if (held.length === 0) {
        return refuse(`no machine is enrolled under that name`, 404);
    }
    revokedMachines.add(machine);
    for (const device of held) {
        if (device.hostId !== undefined) {
            switchDemoPairings(device.hostId, `sync-unpair`, `demo`);
        }
    }
    pushDomains(`hosts`);
    return { ok: true };
};

// A server-connect code for ConnectHost's command; nothing redeems it, which a real one also waits for.
export const enrollCode = (): RawJsonOutput<`POST /system/enroll/code`> => ({ code: shortCode(), expiresIn: PAIRING_SECONDS });

// Runners: the build server takes heavy work and is current; the old laptop's runner has not been seen for days and
// still runs the settings it had then.
const runners: RunnerSummary[] = [
    {
        id: `build-box`,
        host: `build-box`,
        online: true,
        version: `1.320.4`,
        image: `ghcr.io/intentic/sandbox:stable`,
        channel: `stable`,
        overlayHash: `sha256:1f4c9ab2`,
        facts: { cpus: 32, memoryMb: 131_072, freeDiskMb: 402_118, load: 0.22, memoryFreeMb: 96_410, memoryLimitMb: 122_880 },
        lastSeen: STARTED - 20_000,
        parity: `current`,
        drift: [{ subject: `Setting timezone`, detail: `The runner fires schedules by UTC; this sandbox by Europe/Warsaw.` }],
    },
    {
        id: `old-thinkpad`,
        host: `old-thinkpad`,
        online: false,
        version: `1.311.0`,
        image: `ghcr.io/intentic/sandbox:stable`,
        channel: `stable`,
        overlayHash: `sha256:0b7e19d4`,
        lastSeen: STARTED - 4 * 24 * HOUR,
        parity: `outdated`,
        drift: [{ subject: `Environment overlay`, detail: `The runner was built before postgresql-client and Playwright joined the image; it needs a rebuild.` }],
    },
];

export const runnersList = (): RunnerSummary[] => runners.map((runner) => ({ ...runner }));

export const forgetRunner = (id: string): RawJsonOutput<`DELETE /system/runners/{id}`> => {
    const at = runners.findIndex((runner) => runner.id === id);
    if (at === -1) {
        return refuse(`no runner by that id`, 404);
    }
    runners.splice(at, 1);
    pushDomains(`runners`);
    return { ok: true };
};

/** Pushes this sandbox's settings over the runner's live link; an offline one is refused, as the daemon's 409. */
export const syncRunnerDefinition = async (id: string): Promise<RawJsonOutput<`POST /system/runners/{id}/definition/sync`>> => {
    const runner = runners.find((candidate) => candidate.id === id) ?? refuse(`no runner by that id`, 404);
    if (!runner.online) {
        return refuse(`${id} is offline; its settings can be pushed once it connects again`, 409);
    }
    await pause(RUNNER_SYNC_MS);
    // Settings only: an overlay difference still needs a rebuild, so it stays listed.
    runner.drift = (runner.drift ?? []).filter((line) => !line.subject.startsWith(`Setting`));
    pushDomains(`runners`);
    return { settings: [`timezone`, `skills`, `personaRouting`, `chatPages`] };
};

// Phones: none paired at first. Adding the Android card mints a pairing, and the recording's Pixel scans its code a
// few seconds later, so the card goes from its QR code to a connected phone the way it does when somebody scans it.
const phones = new Map<string, PhoneSummary>();

const pixel = (id: string): PhoneSummary => ({
    id,
    platform: `android`,
    online: true,
    paired: true,
    version: `1.275.0`,
    lastSeen: Date.now(),
    facts: {
        device: `Google Pixel 8`,
        android: `16`,
        sdk: 36,
        build: `direct`,
        paused: false,
        access: { accessibility: true, notifications: false, screenCapture: `accessibility` },
        folders: [{ name: `DCIM`, writable: false }, { name: `Download`, writable: true }],
        apps: [{ package: `com.google.android.gm`, label: `Gmail`, mode: `read` }],
        battery: { level: 81, charging: false },
        wake: { fcm: `fcm-demo-pixel-8` },
    },
    wake: `register`,
});

export const phonesList = (): PhoneSummary[] => [...phones.values()];

export const pairPhone = (id: string): RawJsonOutput<`POST /system/phones/pair`> => {
    setTimeout(() => {
        phones.set(id, pixel(id));
        pushDomains(`phones`);
    }, PHONE_SCANS_AFTER_MS);
    return { token: token(`phone`), expiresIn: PAIRING_SECONDS };
};

export const unpairPhone = (id: string): RawJsonOutput<`DELETE /system/phones/{id}`> => {
    phones.delete(id);
    pushDomains(`phones`);
    return { ok: true };
};

/** The phone's wake registered through the push relay, so the sandbox can wake it when a tool needs it. */
export const registerPhoneWake = (id: string): RawJsonOutput<`POST /system/phones/{id}/wake`> => {
    const phone = phones.get(id) ?? refuse(`no phone by that id is paired`, 404);
    phones.set(id, { ...phone, wake: `ready` });
    pushDomains(`phones`);
    return { ok: true };
};
