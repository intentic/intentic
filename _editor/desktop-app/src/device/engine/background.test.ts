import { registerDesktopCatalog } from "../../i18n";
import type { EngineStatus } from "../../desktopEngine";
import { keptRunningSaid, modeConsequence, modeOptions, nowOf, nowPress, nowWords, othersKeepWsl, startupSwitchedOff } from "./background";

// What runs in the background, in the reader's words: what each mode does to this computer's own sandboxes, what the
// engine is doing now and why, and the press beside it.

await registerDesktopCatalog();

const OURS: EngineStatus = {
    engine: `intentic`,
    chosen: `intentic`,
    installed: true,
    running: true,
    version: `1`,
    active: true,
    held: false,
    distro: `intentic-engine`,
    dockerDesktop: false,
    ownEngine: true,
    preferred: null,
    gpu: false,
    bringYourOwn: false,
    canMove: false,
    offerMove: false,
    mode: `always`,
    hold: null,
    signIn: { by: `app`, disabledInWindows: false },
    wslMemoryBytes: 1.5 * 1024 ** 3,
    otherDistros: [],
};
const now = (status: Partial<EngineStatus>, listening: boolean | undefined = undefined) =>
    nowOf({ status: { ...OURS, ...status }, listening, starting: false, toggling: undefined });

it(`says what each choice does with this computer's own count of sandboxes, in general while it is unknown, and nothing of none`, () => {
    expect(modeConsequence(`off`, 3)).toBe(`Nothing runs, even when Intentic is open. 3 sandboxes here can't be reached.`);
    expect(modeConsequence(`always`, 1)).toBe(`Starts when you sign in to Windows. 1 sandbox here stays reachable from the browser and your phone.`);
    expect(modeConsequence(`whenOpen`, 2)).toBe(`Starts with Intentic and stops when you quit it. While it's closed, 2 sandboxes here can't be reached.`);
    expect(modeConsequence(`off`, undefined)).toBe(`Nothing runs, even when Intentic is open. Sandboxes here can't be reached.`);
    expect(modeConsequence(`off`, 0)).toBe(`Nothing runs, even when Intentic is open.`);
    expect(modeOptions(2).map((option) => [option.value, option.label])).toEqual([
        [`always`, `Always`],
        [`whenOpen`, `When Intentic is open`],
        [`off`, `Off`],
    ]);
});

it(`reads the engine as running when it answers, and when it does not, by the hold that keeps it down`, () => {
    expect(now({}, true)).toEqual({ kind: `running` });
    // Before the page has looked, ic's own word.
    expect(now({ running: true })).toEqual({ kind: `running` });
    expect(now({ running: false, held: true, hold: `stopped` }, false)).toEqual({ kind: `held`, hold: `stopped` });
    expect(now({ running: false, held: true, hold: `off` }, false)).toEqual({ kind: `held`, hold: `off` });
    expect(now({ running: false, held: true, hold: `closed` }, false)).toEqual({ kind: `held`, hold: `closed` });
    // An ic from before kinds: a hold was a person's stop.
    expect(now({ running: false, held: true, hold: undefined }, false)).toEqual({ kind: `held`, hold: `stopped` });
    expect(now({ running: false }, false)).toEqual({ kind: `down` });
    // A press here wins over what was last read.
    expect(nowOf({ status: OURS, listening: true, starting: false, toggling: `stop` })).toEqual({ kind: `stopping` });
    expect(nowOf({ status: { ...OURS, running: false }, listening: false, starting: true, toggling: undefined })).toEqual({ kind: `starting` });
});

it(`says the state by why, and while it runs, its sandboxes and the memory WSL holds`, () => {
    expect(nowWords({ kind: `running` }, 2, 1.5 * 1024 ** 3)).toEqual({ state: `Running`, sandboxes: `2 sandboxes`, memory: `1.5 GB` });
    expect(nowWords({ kind: `running` }, 0, null)).toEqual({ state: `Running`, sandboxes: `no sandboxes`, memory: undefined });
    expect(nowWords({ kind: `running` }, undefined, undefined)).toEqual({ state: `Running`, sandboxes: undefined, memory: undefined });
    expect(nowWords({ kind: `held`, hold: `stopped` }, 0, null).state).toBe(`Stopped by you`);
    expect(nowWords({ kind: `held`, hold: `off` }, 0, null).state).toBe(`Off`);
    expect(nowWords({ kind: `held`, hold: `closed` }, 0, null).state).toBe(`Stopped until you open Intentic`);
    expect(nowWords({ kind: `down` }, 0, null).state).toBe(`Not running`);
});

it(`names the reader's own distros that keep WSL up once the engine is stopped, never while it runs`, () => {
    expect(othersKeepWsl({ kind: `held`, hold: `off` }, [`archlinux`], 800 * 1024 ** 2)).toBe(`WSL keeps running for archlinux and still holds 800 MB.`);
    expect(othersKeepWsl({ kind: `down` }, [`archlinux`, `Ubuntu`], null)).toBe(`WSL keeps running for archlinux and Ubuntu, so its memory stays in use.`);
    expect(othersKeepWsl({ kind: `running` }, [`archlinux`], null)).toBeUndefined();
    expect(othersKeepWsl({ kind: `held`, hold: `stopped` }, [], null)).toBeUndefined();
});

it(`offers Stop now while it runs and Start while it is down, bright only for an engine that went down by itself`, () => {
    expect(nowPress({ kind: `running` }, undefined)).toEqual({ verb: `stop`, tier: `boring` });
    expect(nowPress({ kind: `held`, hold: `stopped` }, undefined)).toEqual({ verb: `start`, tier: `boring` });
    expect(nowPress({ kind: `down` }, undefined)).toEqual({ verb: `start`, tier: `accent` });
    expect(nowPress({ kind: `stopping` }, `stop`)).toEqual({ verb: `stop`, tier: `boring` });
    // The app's own start (the Docker card's) has no press here.
    expect(nowPress({ kind: `starting` }, undefined)).toBeUndefined();
});

it(`says Windows switched the sign-in start off only where the setting means to start there`, () => {
    expect(startupSwitchedOff({ ...OURS, signIn: { by: `app`, disabledInWindows: true } })).toBe(true);
    expect(startupSwitchedOff({ ...OURS, mode: `whenOpen`, signIn: { by: `none`, disabledInWindows: true } })).toBe(false);
    expect(startupSwitchedOff(OURS)).toBe(false);
});

it(`says Intentic keeps the engine running only where it does`, () => {
    expect(keptRunningSaid(`always`)).toBe(true);
    expect(keptRunningSaid(undefined)).toBe(true);
    expect(keptRunningSaid(null)).toBe(true);
    expect(keptRunningSaid(`whenOpen`)).toBe(false);
    expect(keptRunningSaid(`off`)).toBe(false);
});
