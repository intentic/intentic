import { cardSubline, groupChips, groupSummary, type DeviceSandboxGroup, keeperLine, versionLine } from "@intentic/ui/device";
import { rollbackToPrompt } from "@intentic/ui";

// A sandbox row's version facts (_editor/ui/src/components/sandbox/deviceDetail.ts), read off an `ic` new enough to
// report them: what runs, until when the version before the last swap stays ready, and an update interrupted with the
// old container set aside, which is down until Start puts it back. Instants are built on the runner's own calendar.

const NOW = new Date(2026, 8, 28, 16, 30).getTime();

it(`says what runs and, while the version before stays parked, until when`, () => {
    const box = { slug: `work`, running: true, image: `intentic/sandbox:stable`, version: `1.316.0` };
    expect(versionLine({ ...box, probationUntil: new Date(2026, 8, 29, 14, 5).getTime() }, NOW)).toBe(
        `1.316.0 · previous version ready until 14:05 tomorrow`,
    );
    expect(versionLine({ ...box, probationUntil: NOW - 1 }, NOW)).toBe(`1.316.0`);
    expect(versionLine({ slug: `work`, running: true, image: `intentic/sandbox:stable` }, NOW)).toBeUndefined();
});

it(`raises an interrupted update as the reason to open the row, naming the press that brings it back`, () => {
    const group: DeviceSandboxGroup = {
        sandboxId: `work`,
        title: `work`,
        sandbox: { slug: `work`, running: false, image: `intentic/sandbox:stable`, parked: true },
        ports: [],
    };
    expect(groupSummary(group).warnings).toEqual([`interrupted update — Start puts it back`]);
    expect(groupChips(group)[0]).toMatchObject({ tone: `warning`, text: `interrupted update — Start puts it back` });
});

it(`asks before going back to an older kept version, naming it`, () => {
    expect(rollbackToPrompt(`work`, `1.314.0`)).toEqual({
        header: `Roll work back to 1.314.0?`,
        body: `The sandbox restarts onto 1.314.0, an older version this machine kept. Its files are kept.`,
    });
});

// One Docker engine serves a Windows PC and its WSL distros, so a card lists the other side's sandboxes too: it says
// which side looks after each, and when this side took one over because the other went quiet.
it(`names the side of this computer that keeps a sandbox, and an adoption`, () => {
    const box = { slug: `work`, running: true, image: `intentic/sandbox:stable` };
    expect(keeperLine(box)).toBeUndefined();
    expect(keeperLine({ ...box, keptElsewhere: `linux/archlinux`, keptElsewhereName: `WSL (archlinux)` })).toBe(`kept by WSL (archlinux) on this computer`);
    expect(keeperLine({ ...box, keptElsewhere: `windows` })).toBe(`kept by windows on this computer`);
    expect(keeperLine({ ...box, adoptedFrom: `WSL (archlinux)` })).toBe(`looked after from here: WSL (archlinux) went quiet`);
    const group: DeviceSandboxGroup = { sandboxId: `work`, title: `work`, sandbox: { ...box, keptElsewhereName: `Windows`, keptElsewhere: `windows` }, ports: [] };
    expect(cardSubline(group, NOW)).toEqual([`kept by Windows on this computer`]);
});
