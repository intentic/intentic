// WHAT "KILL 3 INACTIVE TERMINALS" IS ALLOWED TO MEAN.
//
// The row states a count and kills whatever that count stood for, so this rule is the whole safety of the
// gesture: every terminal it names is one the user has finished with, and every terminal it spares is one they
// would have lost without being asked. The two directions fail differently, and both are here: a sweep that
// takes too little is a menu row that did not tidy, while a sweep that takes too much is a build ended in
// silence.
//
// `now` and the threshold are injected, so a case can put a session an hour in the past without waiting.
import { expect, test } from "vitest";
import type { TerminalTab } from "./useTerminal";
import { inactiveReason, inactiveTerminals, QUIET_MS } from "./terminalSweep";

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const minutesAgo = (minutes: number): number => NOW - minutes * 60_000;
// The threshold itself is read from the module, not transcribed: these cases are about "past it" and "inside
// it", and they have to keep meaning that if the ten minutes are ever retuned.
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

// The clock is the reason there IS a threshold: without it the sweep takes the shell you ran a command in
// moments ago, which is a shell you are in the middle of using.
test(`a shell that spoke inside the threshold is spared`, () => {
    expect(swept([tab(`web-fresh`, { activityAt: minutesAgo(QUIET_MINUTES - 1) })])).toEqual([]);
});

/* THE EXPENSIVE MISTAKE. A compile prints nothing for twenty minutes, so by the clock alone it is the quietest
 * thing on the strip: `command` is what keeps the sweep off it, and it outranks any amount of silence. */
test(`a terminal with a command running is spared however long it has been silent`, () => {
    expect(swept([tab(`web-build`, { command: `pnpm build`, activityAt: minutesAgo(QUIET_MINUTES * 10) })])).toEqual([]);
});

// A dead pane has nothing to be quiet about and no clock worth consulting (tmux often leaves it at 0), so it
// sweeps on the strength of being over.
test(`a finished session is inactive whatever its clock says`, () => {
    expect(swept([tab(`panel-app`, { kind: `panel`, running: false, activityAt: 0 })])).toEqual([`panel-app`]);
});

// 0 is "tmux did not say", never 1970: a live session whose age is unknown cannot be shown to be quiet, and a
// sweep may not kill what it cannot age.
test(`a live session with no stamp is spared`, () => {
    expect(swept([tab(`web-unstamped`, { activityAt: 0 })])).toEqual([]);
});

// Sweeping the pane being read would empty the panel out from under it, which is the row directly below this
// one ("Kill all terminals"), not this one.
test(`the focused terminal is spared even at a prompt`, () => {
    expect(swept([tab(`web-here`), tab(`web-other`)], `web-here`)).toEqual([`web-other`]);
});

// A process row's × closes a read-only log VIEW; the process itself is stopped from the popover. Sweeping one
// would be a no-op that inflated the count the row promised.
test(`a background process's log view is never swept`, () => {
    expect(swept([tab(`svc-gateway`, { kind: `process` }), tab(`web-old`)])).toEqual([`web-old`]);
});

// The mixed strip, end to end: what the row's number is counting.
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

// What each swept row says in the confirm: the count is only checkable if the lines say what made them qualify.
test(`each swept terminal says why it qualified`, () => {
    expect(inactiveReason(tab(`web-old`, { activityAt: minutesAgo(42) }), NOW)).toBe(`last output 42m ago`);
    expect(inactiveReason(tab(`panel-app`, { running: false, activityAt: 0 }), NOW)).toBe(`finished`);
});
