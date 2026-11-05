// What the card's list is built from: route names folded into areas of the product, ranked by consequence.
// Pure, so this pins the naming and the order without a daemon or a mount.
import { setLocale } from "@intentic/ui/i18n";
import { driftAreas, driftGroups, kindImpact, kindTag } from "./driftReport";

it(`names an area as the product names it, not as the contract does`, () => {
    const [area] = driftAreas({ missing: [], drifted: [`agent.send`, `agent.stop`], extra: [] });
    expect(area).toMatchObject({
        key: `agent`,
        label: `Running a turn`,
        where: `sending, stopping and following a turn`,
        kind: `drifted`,
        count: 2,
    });
});

// The hand-written routes are keyed `METHOD /path`, and splitting those on a dot put every one of them in a row of its
// own named after the verb. They belong in the row a reader would look for: the one their path's first segment names.
it(`folds a hand-written route into the area its path names`, () => {
    const [area] = driftAreas({ missing: [`GET /system/links`], drifted: [`system.terminals`], extra: [] });
    expect(area).toMatchObject({
        key: `system`,
        label: `Terminals and devices`,
        kind: `missing`,
        missing: [`GET /system/links`],
        drifted: [`system.terminals`],
        count: 2,
    });
});

// Two different unnamed cases, and telling the reader the wrong one sends them to update a sandbox that is already
// current: a group only the DAEMON named is newer than this page, one of our own is merely unlabelled here, and says
// nothing rather than "a part this page has no plain name for".
it(`tells an unlabelled area of our own from a feature this page predates`, () => {
    const [ours] = driftAreas({ missing: [`POST /intake/scan`], drifted: [], extra: [] });
    expect(ours).toMatchObject({ key: `intake`, label: `Intake`, where: undefined });
    const [theirs] = driftAreas({ missing: [], drifted: [], extra: [`GET /teleport/status`] });
    expect(theirs).toMatchObject({ key: `teleport`, where: `something newer than this page` });
});

// A group only the daemon has is a feature this build predates, so there is no honest label for it — and inventing
// one would be worse than admitting that.
it(`falls back to the group's own name for a route this build has never heard of`, () => {
    const [area] = driftAreas({ missing: [], drifted: [], extra: [`teleport.engage`] });
    expect(area).toMatchObject({ key: `teleport`, label: `Teleport`, where: `something newer than this page`, kind: `extra` });
});

// Worst first: a call that isn't there takes the feature with it, a drifted one answers and lies, an extra one costs
// nothing. Size breaks ties inside a kind, so the alphabet never outranks consequence.
it(`ranks by consequence, then by how much of the area is affected`, () => {
    const areas = driftAreas({
        missing: [`vpn.status`],
        drifted: [`agents.list`, `git.status`, `git.log`, `git.diff`],
        extra: [`teleport.engage`],
    });
    expect(areas.map((area) => [area.key, area.kind, area.count])).toEqual([
        [`vpn`, `missing`, 1],
        [`git`, `drifted`, 3],
        [`agents`, `drifted`, 1],
        [`teleport`, `extra`, 1],
    ]);
});

// The card draws one line per kind, so the kind is said once rather than once per area; an area sits on the line of
// the worst kind it holds, and a kind with nothing in it draws no line at all.
it(`groups the areas into one line per kind, worst kind first`, () => {
    const groups = driftGroups(
        driftAreas({ missing: [`vpn.status`, `git.blame`], drifted: [`git.status`, `agents.list`, `settings.get`], extra: [] }),
    );
    expect(groups.map((group) => [group.kind, group.areas.map((area) => area.key)])).toEqual([
        [`missing`, [`git`, `vpn`]],
        [`drifted`, [`settings`, `agents`]],
    ]);
});

// One area can be hit both ways at once; the row states the worst of them and still carries every name behind it.
it(`keeps all three kinds on one area and reports the worst`, () => {
    const [area] = driftAreas({ missing: [`git.blame`], drifted: [`git.status`], extra: [`git.future`] });
    expect(area).toMatchObject({ key: `git`, kind: `missing`, count: 3, missing: [`git.blame`], drifted: [`git.status`], extra: [`git.future`] });
});

// Read when asked, never at import: a reader who switches to Polish after the page loaded gets the areas, the badges,
// and the costs in Polish, while a group this build has never heard of keeps its own name.
it(`names everything in the language the reader switched to after the page loaded`, async () => {
    try {
        await setLocale(`pl`);
        const areas = driftAreas({ missing: [`vpn.status`], drifted: [], extra: [`teleport.engage`] });
        expect(areas.map(({ label, where }) => [label, where])).toEqual([
            [`VPN`, `połączenie VPN tego sandboxa`],
            [`Teleport`, `coś nowszego niż ta strona`],
        ]);
        expect(kindTag(`drifted`)).toBe(`Może działać źle`);
        expect(kindImpact(`extra`)).toBe(
            `Twój sandbox to ma, ale ta strona jest za stara, żeby z tego korzystać. Nic się nie zepsuło — po prostu jeszcze tego nie dostajesz.`,
        );
    } finally {
        await setLocale(`en`);
    }
});

// An area whose calls answer alike and differ only in an optional part: listed under its own neutral line, after the
// kinds that break something and before the one that costs nothing.
it(`puts an optional-part area between drifted and extra, in a tone that warns of nothing`, async () => {
    const { KIND_TONE } = await import(`./driftReport`);
    const areas = driftAreas({ missing: [], drifted: [`vpn.list`], additive: [`settings.get`], extra: [`future.thing`] });
    expect(driftGroups(areas).map((group) => group.kind)).toEqual([`drifted`, `additive`, `extra`]);
    expect(KIND_TONE.additive).toBe(`neutral`);
    setLocale(`en`);
    expect(kindTag(`additive`)).toBe(`Small differences`);
    expect(kindImpact(`additive`)).toContain(`Nothing is broken`);
});

it(`files an area under the worst kind it holds, even when it holds an optional part too`, () => {
    const [area] = driftAreas({ missing: [], drifted: [`settings.set`], additive: [`settings.get`], extra: [] });
    expect(area).toMatchObject({ key: `settings`, kind: `drifted`, drifted: [`settings.set`], additive: [`settings.get`], count: 2 });
});
