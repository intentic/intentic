import { removalMap } from "./removalMap";

// The removal dialog said what a press cuts in paragraphs nobody read; it now draws it, and these pin what it draws.

const own = { name: `workspace`, role: `owner`, hosted: null } as const;

describe(`removalMap`, () => {
    it(`cuts everyone off an own-machine sandbox and leaves its computer running it`, () => {
        const picture = removalMap(own, { deletes: false, label: `rog` });
        expect(picture.cuts).toEqual([true, false]);
        expect(picture.nodes.map((node) => [node.label, node.fate, node.lost])).toEqual([
            [`Everyone`, `loses access`, true],
            [`workspace`, `off your account`, true],
            [`rog`, `still runs it`, false],
        ]);
    });

    it(`cuts the computer too once its container is to be deleted there`, () => {
        const picture = removalMap(own, { deletes: true, label: `rog` });
        expect(picture.cuts).toEqual([true, true]);
        expect(picture.nodes[2]).toMatchObject({ label: `rog`, fate: `deletes it`, lost: true });
        expect(picture.label).toBe(`Everyone loses access, and its computer deletes it.`);
    });

    it(`names no computer it has not found`, () => {
        expect(removalMap(own, { deletes: false, label: undefined }).nodes[2].label).toBe(`Its computer`);
    });

    it(`stops a hosted machine whatever the tick box says`, () => {
        const picture = removalMap({ ...own, hosted: {} }, { deletes: false, label: undefined });
        expect(picture.cuts).toEqual([true, true]);
        expect(picture.nodes[2]).toMatchObject({ icon: `cloud`, fate: `stops now`, lost: true });
    });

    it(`cuts only the member leaving, and leaves the sandbox running for everyone else`, () => {
        const picture = removalMap({ ...own, role: `collaborator` }, { deletes: true, label: `rog` });
        expect(picture.cuts).toEqual([true, false]);
        expect(picture.nodes.map((node) => node.lost)).toEqual([true, false, false]);
        expect(picture.nodes[0].label).toBe(`You`);
    });
});
