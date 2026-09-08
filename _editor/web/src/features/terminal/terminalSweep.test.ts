// Pins which terminals the sweep gesture calls inactive; now and the quiet threshold are injected so cases avoid real
// waits.
import { expect, test } from "vitest";
import type { TerminalTab } from "./useTerminal";
import { inactiveReason, inactiveTerminals, QUIET_MS } from "./terminalSweep";

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;
// Derived from QUIET_MS rather than hardcoded, so these cases still hold if it's retuned.
const QUIET_MINUTES = QUIET_MS / 60_000;

const tab = (name: string, over: Partial<TerminalTab> = {}): TerminalTab => ({
    name,
    kind: `shell`,
    running: true,
    activityAt: minutesAgo(QUIET_MINUTES * 2),
    ...over,
});
const swept = (tabs: TerminalTab[], focused?: string): string[] => inactiveTerminals(tabs, { now: NOW, focused }).map((session) => session.name);

test(`a shell that has sat at its prompt past the threshold is inactive`, () => {
    expect(swept([tab(`web-old`, { activityAt: minutesAgo(QUIET_MINUTES + 1) })])).toEqual([`web-old`]);
});

test(`a shell that spoke inside the threshold is spared`, () => {
    expect(swept([tab(`web-fresh`, { activityAt: minutesAgo(QUIET_MINUTES - 1) })])).toEqual([]);
});

test(`a terminal with a command running is spared however long it has been silent`, () => {
    expect(swept([tab(`web-build`, { command: `pnpm build`, activityAt: minutesAgo(QUIET_MINUTES * 10) })])).toEqual([]);
});

test(`a finished session is inactive whatever its clock says`, () => {
    expect(swept([tab(`panel-app`, { kind: `panel`, running: false, activityAt: 0 })])).toEqual([`panel-app`]);
});

// activityAt 0 means unmeasured, not epoch; a session tmux gave no stamp for cannot be aged.
test(`a live session with no stamp is spared`, () => {
    expect(swept([tab(`web-unstamped`, { activityAt: 0 })])).toEqual([]);
});

test(`the focused terminal is spared even at a prompt`, () => {
    expect(swept([tab(`web-here`), tab(`web-other`)], `web-here`)).toEqual([`web-other`]);
});

test(`a background process's log view is never swept`, () => {
    expect(swept([tab(`svc-gateway`, { kind: `process` }), tab(`web-old`)])).toEqual([`web-old`]);
});

test(`a strip of every kind sweeps down to the quiet and the finished`, () => {
    const strip = [
        tab(`web-here`),
        tab(`web-old`, { activityAt: minutesAgo(QUIET_MINUTES * 4) }),
        tab(`web-fresh`, { activityAt: minutesAgo(1) }),
        tab(`web-build`, { command: `vitest` }),
        tab(`agent-a1b2`, { kind: `agent`, running: false, activityAt: 0 }),
        tab(`svc-docker`, { kind: `process` }),
    ];
    expect(swept(strip, `web-here`)).toEqual([`web-old`, `agent-a1b2`]);
});

test(`each swept terminal says why it qualified`, () => {
    expect(inactiveReason(tab(`web-old`, { activityAt: minutesAgo(42) }), NOW)).toBe(`last output 42m ago`);
    expect(inactiveReason(tab(`panel-app`, { running: false, activityAt: 0 }), NOW)).toBe(`finished`);
});
