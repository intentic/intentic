// Pins what a switch of mode says before it is saved: each rule the sandbox would take over, in acting order, then who
// reads plain words; nothing to take over is said too; back to hands-on changes nothing at once.
import "@intentic/testing/dom";
import { managedRule } from "@intentic/sandbox-contract/schemas/sandbox-mode";

const { modeSwitchLines } = await import(`./useSandboxMode`);

test(`taking over names each rule it would switch on, then the words`, () => {
    expect(modeSwitchLines(`hands-on`, `hands-off`, [managedRule(`version`)])).toEqual([
        `Finished work goes in by itself.`,
        `Saved versions are backed up wherever this project has a remote.`,
        `Everyone who hasn't picked their own words here sees plain ones.`,
    ]);
});

test(`a sandbox already doing all three is told it stays that way`, () => {
    const lines = modeSwitchLines(`hands-on`, `hands-off`, [managedRule(`land`), managedRule(`version`), managedRule(`push`)]);
    expect(lines[0]).toContain(`stays that way`);
    expect(lines).toHaveLength(2);
});

test(`going back to hands-on changes nothing at once, and no switch says nothing`, () => {
    expect(modeSwitchLines(`hands-off`, `hands-on`, [])).toEqual([
        `Nothing changes right away: what happens to finished work stays as it is, and is yours to change from now on.`,
    ]);
    expect(modeSwitchLines(`hands-off`, `hands-off`, [])).toEqual([]);
});
