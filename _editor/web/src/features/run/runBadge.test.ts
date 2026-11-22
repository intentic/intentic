import { runBadgeOf } from "./runBadge";
import type { RunItem, RunLane, RunState } from "./runLanes";

// The Run tile's badge: an error owed first, then what runs as a neutral count, a build in flight as the turning mark.

const item = (key: string, state: RunState): RunItem => ({ key, repo: `shop`, row: undefined, run: undefined, terminal: undefined, state });

const lane = (place: string, ...active: RunItem[]): RunLane => ({
    place,
    device: undefined,
    block: undefined,
    active,
    idle: [],
    runnable: [],
    listError: undefined,
});

test(`nothing running, nothing on the way: no badge`, () => {
    expect(runBadgeOf([])).toBeUndefined();
    expect(runBadgeOf([lane(`sandbox`)])).toBeUndefined();
});

test(`what runs is counted across every place, neutral, with a program that may be running counted as up`, () => {
    const badge = runBadgeOf([lane(`sandbox`, item(`web`, `running`)), lane(`rog`, item(`app`, `unknown`))]);
    expect(badge).toEqual({ count: 2, tone: `neutral`, tooltip: `2 running` });
});

test(`a program that stopped with an error is counted in danger, ahead of what runs`, () => {
    const badge = runBadgeOf([lane(`sandbox`, item(`web`, `running`)), lane(`rog`, item(`app`, `failed`))]);
    expect(badge).toEqual({ count: 1, tone: `danger`, tooltip: `1 stopped with an error · 1 running` });
    expect(runBadgeOf([lane(`rog`, item(`app`, `failed`))])?.tooltip).toBe(`1 stopped with an error`);
});

test(`a build still going is the turning mark, alone or beside a count`, () => {
    expect(runBadgeOf([lane(`rog`, item(`app`, `starting`))])).toEqual({ running: `1 starting` });
    expect(runBadgeOf([lane(`sandbox`, item(`web`, `running`)), lane(`rog`, item(`app`, `starting`))])).toEqual({
        count: 1,
        tone: `neutral`,
        tooltip: `1 running`,
        running: `1 starting`,
    });
});
