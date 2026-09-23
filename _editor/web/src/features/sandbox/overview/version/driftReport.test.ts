// What the card's list is built from: route names folded into areas of the product, ranked by consequence.
// Pure, so this pins the naming and the order without a daemon or a mount.
import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import { driftAreas } from "./driftReport";

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

// `agent` and `agents` are one letter apart and are not the same thing; the old card printed both prefixes and left
// the reader to guess. Every group the contract ships gets a name of its own here.
it(`has a name for every group in the shipped contract`, () => {
    const groups = [...new Set(SANDBOX_ROUTE_NAMES.map((name) => name.split(`.`)[0] ?? name))];
    const unnamed = driftAreas({ missing: groups.map((group) => `${group}.probe`), drifted: [], extra: [] })
        .filter((area) => area.where === `something newer than this page`)
        .map((area) => area.key);
    expect(unnamed).toEqual([]);
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

// One area can be hit both ways at once; the row states the worst of them and still carries every name behind it.
it(`keeps all three kinds on one area and reports the worst`, () => {
    const [area] = driftAreas({ missing: [`git.blame`], drifted: [`git.status`], extra: [`git.future`] });
    expect(area).toMatchObject({ key: `git`, kind: `missing`, count: 3, missing: [`git.blame`], drifted: [`git.status`], extra: [`git.future`] });
});
