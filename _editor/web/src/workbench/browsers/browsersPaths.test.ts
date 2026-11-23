// The Browsers view's tab keys: a runner's desktop and its windows keyed apart from this sandbox's own, and read back.
import { parseTabKey, tabKey } from "./browsersPaths";

it("keys this sandbox's desktop and its windows as before", () => {
    expect([tabKey({ kind: `desktop` }), tabKey({ kind: `app`, id: `0x1a` })]).toEqual([`desktop`, `app:0x1a`]);
    expect([parseTabKey(`desktop`), parseTabKey(`app:0x1a`)]).toEqual([{ kind: `desktop` }, { kind: `app`, id: `0x1a` }]);
});

it("keys a runner's desktop and its windows by the runner, and reads them back", () => {
    expect([tabKey({ kind: `desktop`, runner: `rog` }), tabKey({ kind: `app`, id: `0x1a`, runner: `rog` })]).toEqual([`desktop:rog`, `app:rog~0x1a`]);
    expect([parseTabKey(`desktop:rog`), parseTabKey(`app:rog~0x1a`)]).toEqual([
        { kind: `desktop`, runner: `rog` },
        { kind: `app`, id: `0x1a`, runner: `rog` },
    ]);
});

it("reads a runner's browser window as a web tab, by its merged name", () => {
    expect(parseTabKey(`rog~browser-1`)).toEqual({ kind: `web`, session: `rog~browser-1` });
});
