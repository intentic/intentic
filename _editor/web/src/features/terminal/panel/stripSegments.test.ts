import "@intentic/testing/dom";
import { setTerminalMeta, TERMINAL_COLORS } from "../terminalMeta";
import type { TerminalTab } from "../useTerminal";
import { clearedLabel, cycled, segmentColor, iconFor, labelFor, tooltipFor, stripIndex } from "./stripSegments";

// Pins what a pill says: the reader's overrides over the tab's facts over the strip position, the kind's glyph by
// default, and a tooltip that leads with the running command and otherwise says what the session is.

const tab = (over: Partial<TerminalTab> = {}): TerminalTab => ({ name: `web-1`, kind: `shell`, running: true, activityAt: 0, ...over });

afterEach(() => {
    setTerminalMeta(`web-1`, { label: undefined, color: undefined, icon: undefined });
});

describe(`a pill`, () => {
    it(`numbers sessions in reading order across split groups`, () => {
        expect([...stripIndex([[`a`], [`b`, `c`], [`d`]])]).toEqual([
            [`a`, 1],
            [`b`, 2],
            [`c`, 3],
            [`d`, 4],
        ]);
    });

    it(`labels a session by the reader's name, else its own, else its position`, () => {
        expect(labelFor(`web-1`, tab(), 3)).toBe(`3`);
        expect(labelFor(`web-1`, tab({ label: `dev server` }), 3)).toBe(`dev server`);
        setTerminalMeta(`web-1`, { label: `api` });
        expect(labelFor(`web-1`, tab({ label: `dev server` }), 3)).toBe(`api`);
        expect([clearedLabel(tab(), 3), clearedLabel(tab({ label: `dev server` }), 3)]).toEqual([`Terminal 3`, `dev server`]);
    });

    it(`wears the kind's glyph and no colour until the reader picks them`, () => {
        expect([iconFor(`web-1`, tab({ kind: `agent` })), segmentColor(`web-1`)]).toEqual([`sparkles`, undefined]);
        setTerminalMeta(`web-1`, { icon: `star`, color: `cyan` });
        expect([iconFor(`web-1`, tab({ kind: `agent` })), segmentColor(`web-1`)]).toEqual([`star`, TERMINAL_COLORS.cyan]);
    });

    it.each<[string, TerminalTab | undefined, string | undefined]>([
        [`nothing for a pill with no tab`, undefined, undefined],
        [`a read-only log view for a process`, tab({ kind: `process`, command: `tail -f` }), `Background process: read-only logs`],
        [`the running command first`, tab({ kind: `agent`, command: `pnpm test` }), `Running pnpm test`],
        [`an AI terminal, finished or not`, tab({ kind: `agent`, running: false }), `AI terminal, finished`],
        [`a job terminal`, tab({ kind: `job` }), `Job terminal`],
        [`a finished shell`, tab({ running: false }), `finished`],
        [`nothing for a live shell at its prompt`, tab(), undefined],
    ])(`tells %s`, (_, of, tooltip) => {
        expect(tooltipFor(of)).toBe(tooltip);
    });
});

describe(`cycling tabs`, () => {
    const groups = [[`a`], [`b`, `c`], [`d`]];
    it.each<[string, readonly (readonly string[])[], string | undefined, number, string | undefined]>([
        [`forward through a split`, groups, `b`, 1, `c`],
        [`back past the start to the end`, groups, `a`, -1, `d`],
        [`forward past the end to the start`, groups, `d`, 1, `a`],
        [`nowhere with a single session`, [[`a`]], `a`, 1, undefined],
    ])(`walks %s`, (_, of, active, delta, next) => {
        expect(cycled(of, active, delta)).toBe(next);
    });
});
