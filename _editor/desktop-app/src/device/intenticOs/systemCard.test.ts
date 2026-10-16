import type { IntenticOsStatus } from "@intentic/sandbox-contract/schemas/intentic-os";
import type { OsRunEnd, OsRunEvent } from "../../desktop";
import {
    KEPT_LINES,
    canRollBack,
    canSwitchChannel,
    channelOf,
    checkSaidOf,
    endOf,
    endSaidOf,
    foldRun,
    healthOf,
    isolationOf,
    nextChannelOf,
    restartOf,
    startRun,
    tagOf,
    waitingOf,
    waitingVersionOf,
} from "./systemCard";

// This system as the card reads it: what waits for the next boot and the change that restarts into it, the boot's
// health, isolation, the channel the next boot runs, a check's answer, and a change's lines as every window hears them.
// The statuses are the shapes of _os/README.md's `ic os status --json`.

const BOOTED: IntenticOsStatus = {
    os: `intentic-os`,
    edition: `desktop`,
    version: `2026.10.13.0`,
    channel: `stable`,
    image: `ghcr.io/intentic/os-desktop:stable`,
    booted: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.13.0`, digest: `sha256:a`, timestamp: `2026-10-13T09:12:00Z` },
    staged: null,
    rollback: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.06.0`, digest: `sha256:b`, timestamp: null },
    rollbackQueued: false,
    rebootRequired: false,
    health: { verdict: `green`, failed: [] },
    isolation: `auto`,
    vmRuntime: true,
};
const STAGED: IntenticOsStatus = {
    ...BOOTED,
    staged: { image: `ghcr.io/intentic/os-desktop:stable`, version: `2026.10.20.0`, digest: `sha256:c`, timestamp: null },
    rebootRequired: true,
};
const ROLLBACK_QUEUED: IntenticOsStatus = { ...BOOTED, rollbackQueued: true, rebootRequired: true };

const END: OsRunEnd = { verb: `update`, apply: false, outcome: `done`, code: 0, timedOut: false, reason: null, log: `/logs/u.log`, ran: true };

describe(`what waits for the next boot`, () => {
    it(`is nothing on a computer that booted what it runs, and offers no restart`, () => {
        expect(waitingOf(BOOTED)).toBeUndefined();
        expect(waitingVersionOf(BOOTED)).toBeUndefined();
        expect(restartOf(BOOTED)).toBeUndefined();
    });

    it(`is a staged update, restarted into by applying it, as the OS waits to be told`, () => {
        expect(waitingOf(STAGED)).toBe(`update`);
        expect(waitingVersionOf(STAGED)).toBe(`2026.10.20.0`);
        expect(restartOf(STAGED)).toBe(`applyUpdate`);
    });

    it(`is a queued rollback, restarted into by a plain restart, never by queueing the rollback again`, () => {
        expect(waitingOf(ROLLBACK_QUEUED)).toBe(`rollback`);
        expect(waitingVersionOf(ROLLBACK_QUEUED)).toBe(`2026.10.06.0`);
        expect(restartOf(ROLLBACK_QUEUED)).toBe(`reboot`);
        // bootc boots the queued rollback next, staged image or not.
        expect(restartOf({ ...STAGED, rollbackQueued: true })).toBe(`reboot`);
    });

    it(`says no version where bootc did not say one`, () => {
        expect(waitingVersionOf({ ...STAGED, staged: { image: null, version: null, digest: null, timestamp: null } })).toBeUndefined();
        expect(waitingVersionOf({ ...ROLLBACK_QUEUED, rollback: null })).toBeUndefined();
    });
});

describe(`the quieter changes`, () => {
    it(`offers going back only to a version bootc kept, and only while nothing else waits`, () => {
        expect(canRollBack(BOOTED)).toBe(true);
        expect(canRollBack({ ...BOOTED, rollback: null })).toBe(false);
        expect(canRollBack(STAGED)).toBe(false);
        expect(canRollBack(ROLLBACK_QUEUED)).toBe(false);
    });

    it(`keeps the channel switch away from a queued rollback, which its staged image would replace`, () => {
        expect(canSwitchChannel(BOOTED)).toBe(true);
        expect(canSwitchChannel(STAGED)).toBe(true);
        expect(canSwitchChannel(ROLLBACK_QUEUED)).toBe(false);
    });
});

describe(`the channel`, () => {
    it(`reads an image reference's tag, and nothing from one without`, () => {
        expect(tagOf(`ghcr.io/intentic/os:stable`)).toBe(`stable`);
        expect(tagOf(`ghcr.io/intentic/os-desktop:beta@sha256:abc`)).toBe(`beta`);
        // A registry's port is not a tag.
        expect(tagOf(`localhost:5000/intentic/os`)).toBeUndefined();
        expect(tagOf(`ghcr.io/intentic/os@sha256:abc`)).toBeUndefined();
        expect(tagOf(`ghcr.io/intentic/os:`)).toBeUndefined();
        expect(tagOf(null)).toBeUndefined();
        expect(tagOf(undefined)).toBeUndefined();
    });

    it(`is the one the next boot runs: a switch's staged image, until the restart`, () => {
        expect(nextChannelOf(BOOTED)).toBe(`stable`);
        expect(nextChannelOf(STAGED)).toBe(`stable`);
        expect(nextChannelOf({ ...STAGED, staged: { image: `ghcr.io/intentic/os-desktop:beta`, version: `2026.10.21.0`, digest: null, timestamp: null } })).toBe(`beta`);
        // A staged image bootc names no tag for leaves the booted channel.
        expect(nextChannelOf({ ...STAGED, staged: { image: null, version: null, digest: null, timestamp: null } })).toBe(`stable`);
    });

    it(`offers only stable and beta to switch to`, () => {
        expect(channelOf(`stable`)).toBe(`stable`);
        expect(channelOf(`beta`)).toBe(`beta`);
        expect(channelOf(`nightly`)).toBeUndefined();
        expect(channelOf(``)).toBeUndefined();
    });
});

describe(`the boot's health and isolation`, () => {
    it(`says healthy, failing with what failed, or not checked yet`, () => {
        expect(healthOf(BOOTED)).toEqual({ verdict: `healthy`, tone: `success`, failed: [] });
        const failing: IntenticOsStatus = { ...BOOTED, health: { verdict: `red`, failed: [`sandbox work is not running`, `dockerd did not answer`] } };
        expect(healthOf(failing)).toEqual({ verdict: `failing`, tone: `danger`, failed: [`sandbox work is not running`, `dockerd did not answer`] });
        expect(healthOf({ ...BOOTED, health: { verdict: `unknown`, failed: [] } })).toEqual({ verdict: `unknown`, tone: `neutral`, failed: [] });
    });

    it(`says when the microVMs the policy asks for are missing, and never for containers`, () => {
        expect(isolationOf(BOOTED)).toEqual({ mode: `auto`, vmMissing: false });
        expect(isolationOf({ ...BOOTED, vmRuntime: false })).toEqual({ mode: `auto`, vmMissing: true });
        expect(isolationOf({ ...BOOTED, isolation: `vm`, vmRuntime: false })).toEqual({ mode: `vm`, vmMissing: true });
        expect(isolationOf({ ...BOOTED, isolation: `container`, vmRuntime: false })).toEqual({ mode: `container`, vmMissing: false });
    });
});

describe(`what a check for updates found`, () => {
    it(`offers a newer version, says when there is none, and nothing before a check`, () => {
        expect(checkSaidOf(undefined, BOOTED)).toBeUndefined();
        expect(checkSaidOf({ available: true, version: `2026.10.20.0`, digest: `sha256:c` }, BOOTED)).toEqual({ kind: `available`, version: `2026.10.20.0` });
        expect(checkSaidOf({ available: true, version: null, digest: null }, BOOTED)).toEqual({ kind: `available`, version: undefined });
        expect(checkSaidOf({ available: false, version: null, digest: null }, BOOTED)).toEqual({ kind: `current` });
    });

    it(`offers nothing to download when the version it found is already staged`, () => {
        expect(checkSaidOf({ available: true, version: `2026.10.20.0`, digest: `sha256:c` }, STAGED)).toEqual({ kind: `waiting` });
        // A newer one than the staged is still worth downloading.
        expect(checkSaidOf({ available: true, version: `2026.10.27.0`, digest: `sha256:d` }, STAGED)).toEqual({ kind: `available`, version: `2026.10.27.0` });
    });
});

describe(`a change, as every window hears it`, () => {
    const line = (text: string, verb: `update` | `channel` = `update`): OsRunEvent => ({ kind: `line`, verb, stream: `stdout`, text });

    it(`begins, gathers its lines, and is over at its exit`, () => {
        let run = foldRun(undefined, { kind: `started`, verb: `channel`, apply: false, channel: `beta` });
        expect(run).toEqual({ verb: `channel`, apply: false, channel: `beta`, lines: [] });
        run = foldRun(run, line(`pulling ghcr.io/intentic/os-desktop:beta`, `channel`));
        run = foldRun(run, line(`staged 2026.10.21.0`, `channel`));
        expect(run?.lines).toEqual([`pulling ghcr.io/intentic/os-desktop:beta`, `staged 2026.10.21.0`]);
        expect(run?.channel).toBe(`beta`);
        const exit: OsRunEvent = { kind: `exit`, ...END, verb: `channel` };
        expect(foldRun(run, exit)).toBeUndefined();
        expect(endOf(exit)).toEqual({ ...END, verb: `channel` });
        expect(endOf(line(`not an end`))).toBeUndefined();
    });

    it(`is picked up part way through by a window that opened after it began`, () => {
        expect(foldRun(undefined, line(`downloading 40%`))).toEqual({ verb: `update`, apply: false, lines: [`downloading 40%`] });
        // A line of another change starts that one's reading rather than joining this one's.
        const update = foldRun(startRun(`update`, true), line(`a`));
        expect(foldRun(update, line(`b`, `channel`))).toEqual({ verb: `channel`, apply: false, lines: [`b`] });
    });

    it(`keeps the last lines of a long download, not the first`, () => {
        let run = startRun(`update`, false);
        for (let index = 0; index < KEPT_LINES + 50; index += 1) {
            run = foldRun(run, line(`line ${index}`)) ?? run;
        }
        expect(run.lines).toHaveLength(KEPT_LINES);
        expect(run.lines.at(-1)).toBe(`line ${KEPT_LINES + 49}`);
        expect(run.lines[0]).toBe(`line 50`);
    });

    it(`says how it ended only where the status read after it cannot`, () => {
        expect(endSaidOf(undefined)).toBeUndefined();
        expect(endSaidOf(END)).toBeUndefined();
        expect(endSaidOf({ ...END, apply: true })).toBe(`restarting`);
        expect(endSaidOf({ ...END, outcome: `failed`, code: 1 })).toBe(`failed`);
        expect(endSaidOf({ ...END, outcome: `failed`, code: null, timedOut: true })).toBe(`timedOut`);
        expect(endSaidOf({ ...END, outcome: `notOs`, code: 3 })).toBe(`notOs`);
        expect(endSaidOf({ ...END, outcome: `busy`, code: null, ran: false })).toBe(`busy`);
    });
});
