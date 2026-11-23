import type { GraphEdge } from "./accountGraph";
import { landingTies, stripOf } from "./tieStrip";

// A tie's row of glyphs: every switch keeps its place on or off, so two computers with the same grant draw the same row.

const edge = (extra: Partial<GraphEdge> & Pick<GraphEdge, `kind`>): GraphEdge => ({
    id: `${extra.kind}:a>b`,
    from: `sandbox:a`,
    to: `machine:b`,
    yours: true,
    acting: true,
    ...extra,
});

const lit = (strip: ReturnType<typeof stripOf>, group: string): string[] =>
    strip?.groups.find((found) => found.key === group)?.slots.filter((slot) => slot.on).map((slot) => slot.key) ?? [];

describe(`stripOf`, () => {
    it(`draws a computer's switches in fixed places, agents' then people's, lit where on`, () => {
        const strip = stripOf(edge({ kind: `device`, grants: [`shell`, `screen`, `remoteView`], others: 2 }));
        expect(strip?.groups.map((group) => group.key)).toEqual([`agents`, `people`]);
        expect(strip?.groups[0]?.slots.map((slot) => slot.key)).toEqual([`shell`, `write`, `screen`, `control`, `sandboxes`, `destructive`, `admin`, `programs`]);
        expect(strip?.groups[1]?.slots.map((slot) => slot.key)).toEqual([`remoteView`, `remoteControl`, `remoteTerminal`]);
        expect(lit(strip, `agents`)).toEqual([`shell`, `screen`]);
        expect(lit(strip, `people`)).toEqual([`remoteView`]);
        expect(strip?.others).toBe(2);
    });

    it(`keeps a switch a newer daemon added, after the ones it knows`, () => {
        const strip = stripOf(edge({ kind: `device`, grants: [`shell`, `teleport`] }));
        expect(strip?.groups[0]?.slots.at(-1)).toEqual({ key: `teleport`, icon: `plug`, on: true });
    });

    it(`draws a link's terms, the names it carries, and a far side that said no`, () => {
        const strip = stripOf(
            edge({ kind: `link`, terms: { tasks: true, records: false, operate: true, approve: true, role: `Ops`, runAs: `Night fixer` }, answer: `revoked`, yours: false }),
        );
        expect(lit(strip, `link`)).toEqual([`tasks`, `operate`, `approve`]);
        expect(strip?.names.map((name) => [name.key, name.name])).toEqual([
            [`role`, `Ops`],
            [`runAs`, `Night fixer`],
        ]);
        expect(strip?.answer).toBe(`revoked`);
        expect(strip?.yours).toBe(false);
    });

    it(`says a server's account and admin password, and draws nothing for the way in or where a sandbox runs`, () => {
        const server = stripOf(edge({ kind: `server`, user: `deploy`, admin: true }));
        expect(server?.names).toEqual([{ key: `user`, icon: `user`, name: `deploy` }]);
        expect(server?.admin).toBe(true);
        expect(stripOf(edge({ kind: `member` }))).toBeUndefined();
        expect(stripOf(edge({ kind: `runs` }))).toBeUndefined();
    });
});

describe(`landingTies`, () => {
    it(`is what reaches a thing, drawn on it: devices, servers and links in, never where something runs`, () => {
        const edges = [
            edge({ kind: `device`, id: `d`, to: `machine:b` }),
            edge({ kind: `runs`, id: `r`, to: `machine:b` }),
            edge({ kind: `device`, id: `other`, to: `machine:c` }),
            edge({ kind: `link`, id: `l`, from: `sandbox:c`, to: `machine:b` }),
        ];
        expect(landingTies(edges, `machine:b`).map((found) => found.id)).toEqual([`d`, `l`]);
    });
});
