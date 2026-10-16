// Which loops a chat may put a provider on. The daemon's listing is the whole answer where it gives one: an editor
// offering a loop the daemon behind it does not run would have a turn refused or quietly run on the default.
import { advertisedLoops, harnessOfLoop, liftingLoop, offeredHarness, offeredLoops, offeredLoopsFrom, selectedLoop } from "./offeredLoops";

afterEach(() => {
    advertisedLoops.value = undefined;
});

describe(`offeredLoopsFrom`, () => {
    // An older daemon says nothing, and every one of them ran a provider natively and through Claude Code only.
    it(`keeps to the default loop and Claude Code for a daemon from before the field`, () => {
        expect(offeredLoopsFrom(undefined, `codex`)).toEqual([`codex`, `claude-code`]);
        expect(offeredLoopsFrom(undefined, `grok`)).toEqual([`opencode`, `claude-code`]);
        expect(offeredLoopsFrom(undefined, `claude`)).toEqual([`claude-code`]);
        expect(offeredLoopsFrom(undefined, `cursor`)).toEqual([`vendor`]);
        expect(offeredLoopsFrom(undefined, `endpoint/local`)).toEqual([`claude-code`]);
    });

    it(`offers exactly what the daemon advertised, its default first`, () => {
        expect(offeredLoopsFrom({ codex: [`codex`, `claude-code`, `opencode`] }, `codex`)).toEqual([`codex`, `claude-code`, `opencode`]);
        expect(offeredLoopsFrom({ codex: [`codex`] }, `codex`)).toEqual([`codex`]);
    });

    // A newer daemon's loop has no name in this build; offering it would be a chip labelled with a raw string.
    it(`skips values this build's enum does not know, and native, which names no loop`, () => {
        expect(offeredLoopsFrom({ grok: [`opencode`, `hermes`, `native`, `claude-code`, `claude-code`] }, `grok`)).toEqual([
            `opencode`,
            `claude-code`,
        ]);
    });

    it(`falls back to the provider's own default where the daemon listed nothing usable for it`, () => {
        expect(offeredLoopsFrom({ codex: [`codex`] }, `grok`)).toEqual([`opencode`]);
        expect(offeredLoopsFrom({ grok: [] }, `grok`)).toEqual([`opencode`]);
        // An unknown default still runs as `native` there, so the default chip stands for it.
        expect(offeredLoopsFrom({ grok: [`hermes`, `claude-code`] }, `grok`)).toEqual([`opencode`, `claude-code`]);
    });

    it(`reads this sandbox's listing through offeredLoops`, () => {
        expect(offeredLoops(`codex`)).toEqual([`codex`, `claude-code`]);
        advertisedLoops.value = { codex: [`codex`] };
        expect(offeredLoops(`codex`)).toEqual([`codex`]);
    });
});

describe(`the harness a chip stands for`, () => {
    const offered = [`codex`, `claude-code`] as const;

    it(`lights the default for native, for the default named outright, and for a loop no longer offered`, () => {
        expect(selectedLoop(offered, `native`)).toBe(`codex`);
        expect(selectedLoop(offered, `codex`)).toBe(`codex`);
        expect(selectedLoop(offered, `opencode`)).toBe(`codex`);
        expect(selectedLoop(offered, `claude-code`)).toBe(`claude-code`);
    });

    // An older daemon refuses a harness it has no enum value for, and `native` is the canonical spelling anyway.
    it(`stores native for the default loop's chip, and the loop's own name for any other`, () => {
        expect(harnessOfLoop(offered, `codex`)).toBe(`native`);
        expect(harnessOfLoop(offered, `claude-code`)).toBe(`claude-code`);
    });

    it(`reads a remembered loop that is no longer offered as native`, () => {
        expect(offeredHarness(offered, `claude-code`)).toBe(`claude-code`);
        expect(offeredHarness([`codex`], `claude-code`)).toBe(`native`);
        expect(offeredHarness(offered, `codex`)).toBe(`native`);
    });
});

describe(`liftingLoop`, () => {
    it(`names the offered loop that has none of the current loop's limits`, () => {
        expect(liftingLoop(`grok`, [`opencode`, `claude-code`], `native`)).toBe(`claude-code`);
    });

    it(`names nothing on a loop with no limits, or where no other loop is offered`, () => {
        expect(liftingLoop(`grok`, [`opencode`, `claude-code`], `claude-code`)).toBeUndefined();
        expect(liftingLoop(`grok`, [`opencode`], `native`)).toBeUndefined();
    });
});
