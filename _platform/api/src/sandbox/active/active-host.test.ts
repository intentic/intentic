import type { ActiveHost } from "@intentic/api-contract";
import { activeHostOf, decideActive, isActiveCopy } from "./active-host.js";

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 11, 12, minute));
const rog: ActiveHost = { host: `RADARSU-ROG`, os: `archlinux`, env: `intentic`, manager: `ic`, since: at(0).toISOString() };
const none = { activeHost: null, activeEpoch: 0 };
const held = { activeHost: rog, activeEpoch: 2 };

describe(`decideActive`, () => {
    // Rule (a): nobody holds it, so the first copy that says where it runs does, from that moment, the epoch unmoved.
    it(`makes the first copy to announce active while the row names none`, () => {
        expect(decideActive(none, { instance: `i1`, host: `z440`, os: `linux`, engine: `native` }, { manager: `compose` }, at(5))).toEqual({
            activeHost: { host: `z440`, os: `linux`, env: `native`, manager: `compose`, since: at(5).toISOString() },
            activeEpoch: 0,
            changed: true,
            active: true,
        });
    });

    // Rule (b): a takeover newer than the active host's own moment moves it to the copy that carries it.
    it(`moves the active host to a copy carrying a newer takeover, and bumps the epoch`, () => {
        const takeover = { v: 1 as const, at: at(10).getTime(), by: `claim` as const, machineId: `m-z440`, host: `z440` };
        expect(decideActive(held, { instance: `i2`, host: `z440`, os: `linux` }, { manager: `compose`, takeover }, at(11))).toEqual({
            activeHost: { machineId: `m-z440`, host: `z440`, os: `linux`, manager: `compose`, since: at(10).toISOString() },
            activeEpoch: 3,
            changed: true,
            active: true,
        });
    });

    // A marker older than the takeover that made the current host active lost already: it moves nothing.
    it(`ignores a takeover no newer than the active host's`, () => {
        const takeover = { v: 1 as const, at: at(0).getTime(), by: `move` as const };
        expect(decideActive(held, { instance: `i2`, host: `z440` }, { takeover }, at(11))).toEqual({ ...held, changed: false, active: false });
    });

    // Rule (c): an ordinary announce is told where it stands, from either copy, and changes nothing.
    it(`tells an ordinary announce whether it is the active copy, and moves nothing`, () => {
        expect(decideActive(held, { instance: `i1`, host: `radarsu-rog`, os: `ArchLinux` }, { manager: `ic` }, at(30))).toEqual({
            ...held,
            changed: false,
            active: true,
        });
        expect(decideActive(held, { instance: `i3`, host: `z440`, os: `linux` }, {}, at(30))).toEqual({ ...held, changed: false, active: false });
        expect(decideActive(held, { instance: `i4`, host: `RADARSU-ROG`, os: `windows` }, {}, at(30)).active).toBe(false);
    });

    // A copy that names no machine cannot be placed: it is told nothing, which a daemon reads as it always has.
    it(`tells a copy that names no host nothing, and moves nothing even with a takeover`, () => {
        const takeover = { v: 1 as const, at: at(40).getTime(), by: `claim` as const };
        expect(decideActive(held, { instance: `i5` }, { takeover }, at(41))).toEqual({ ...held, changed: false, active: undefined });
        expect(decideActive(none, undefined, {}, at(41))).toEqual({ ...none, changed: false, active: undefined });
    });
});

describe(`isActiveCopy`, () => {
    it(`matches the machine name case-insensitively and the side only where both name one`, () => {
        expect(isActiveCopy(rog, { host: `radarsu-rog` })).toBe(true);
        expect(isActiveCopy({ ...rog, os: undefined }, { host: `RADARSU-ROG`, os: `windows` })).toBe(true);
        expect(isActiveCopy(rog, { host: `z440`, os: `archlinux` })).toBe(false);
        expect(isActiveCopy(rog, {})).toBe(false);
    });
});

describe(`activeHostOf`, () => {
    it(`reads the column, and nothing from one that does not parse`, () => {
        expect(activeHostOf(rog)).toEqual(rog);
        expect(activeHostOf(null)).toBeNull();
        expect(activeHostOf({ host: 7 })).toBeNull();
    });
});
