// The question before a press on somebody else's conversation: who it is asked about, and that the press waits on its answer.
interface StubCard {
    owner?: { email: string; name?: string };
    title?: string;
    diff?: { files: number };
}
const stub = { cards: new Map<string, StubCard>() };

jest.mock("../../../client/auth/useAuth", () => ({ useAuth: () => ({ user: { value: { email: `me@example.com` } } }) }));
jest.mock("../../../workbench/presence/usePresence", () => ({ presenceOthers: { value: [{ email: `anna@example.com`, name: `Anna Kowalska` }] } }));
jest.mock("../../sandbox/live/fleetAcross", () => ({
    otherBoxes: { value: [{ sandbox: { id: `box-2` }, agents: [{ id: `far`, owner: { email: `anna@example.com` } }] }] },
}));

const setAutoLand = jest.fn(async (_id: string, _on: boolean | null) => undefined);
jest.mock("../useAgents", () => ({ useAgents: () => ({ agentById: (id: string) => stub.cards.get(id), setAutoLand }) }));

const { answerForeign, asksFirst, cleared, foreignAsk, foreignOwner, foreignShare } = await import("./foreignPress");
const { pressAutoLand } = await import("./autoLandPress");

afterEach(() => {
    answerForeign(false);
    stub.cards.clear();
    setAutoLand.mockClear();
});

describe(`foreignOwner`, () => {
    it(`names the owner only when it is somebody else`, () => {
        expect(foreignOwner({ owner: { email: `anna@example.com`, since: 0 } }, `me@example.com`, [])?.email).toBe(`anna@example.com`);
        expect(foreignOwner({ owner: { email: `ME@example.com`, since: 0 } }, `me@example.com`, [])).toBeUndefined();
    });

    it(`has nobody to ask about for an unowned card, a missing card, or a reader with no address`, () => {
        expect(foreignOwner({}, `me@example.com`, [])).toBeUndefined();
        expect(foreignOwner(undefined, `me@example.com`, [])).toBeUndefined();
        expect(foreignOwner({ owner: { email: `anna@example.com`, since: 0 } }, undefined, [])).toBeUndefined();
    });
});

describe(`cleared`, () => {
    it(`lets the reader's own conversation through without asking`, async () => {
        stub.cards.set(`mine`, { owner: { email: `me@example.com` } });
        await expect(cleared(`land`, `mine`, undefined)).resolves.toBe(true);
        expect(foreignAsk.value).toBeUndefined();
    });

    it(`holds somebody else's until the reader answers, naming them and the work`, async () => {
        stub.cards.set(`theirs`, { owner: { email: `anna@example.com` }, title: `Fix signup`, diff: { files: 3 } });
        const pressed = cleared(`land`, `theirs`, undefined);
        expect(foreignAsk.value).toMatchObject({ kind: `land`, id: `theirs`, title: `Fix signup`, files: 3, owner: { name: `Anna Kowalska`, short: `Anna` } });
        answerForeign(true);
        await expect(pressed).resolves.toBe(true);
        expect(foreignAsk.value).toBeUndefined();
    });

    it(`answers no on cancel, and for a question a second press replaced`, async () => {
        stub.cards.set(`theirs`, { owner: { email: `anna@example.com` } });
        const first = cleared(`land`, `theirs`, undefined);
        const second = cleared(`land`, `theirs`, undefined);
        await expect(first).resolves.toBe(false);
        answerForeign(false);
        await expect(second).resolves.toBe(false);
    });

    it(`reads a card in another box from that box's roster`, () => {
        expect(asksFirst(`far`, `box-2`)).toBe(true);
        expect(asksFirst(`far`, undefined)).toBe(false);
    });
});

describe(`foreignShare`, () => {
    it(`counts other people's cards and names each owner once`, () => {
        const share = foreignShare(
            [{ owner: { email: `anna@example.com`, since: 0 } }, { owner: { email: `Anna@example.com`, since: 0 } }, { owner: { email: `me@example.com`, since: 0 } }, {}, { owner: { email: `bo@example.com`, name: `Bo`, since: 0 } }],
            `me@example.com`,
            [{ email: `anna@example.com`, name: `Anna Kowalska` }],
        );
        expect(share.count).toBe(3);
        expect(share.owners.map((owner) => owner.name)).toEqual([`Anna Kowalska`, `Bo`]);
    });
});

describe(`pressAutoLand`, () => {
    beforeEach(() => {
        stub.cards.set(`theirs`, { owner: { email: `anna@example.com` } });
        stub.cards.set(`mine`, { owner: { email: `me@example.com` } });
    });

    it(`writes the reader's own at once, and turning somebody else's off`, async () => {
        await pressAutoLand(`mine`, true, true);
        await pressAutoLand(`theirs`, false, false);
        expect(foreignAsk.value).toBeUndefined();
        expect(setAutoLand.mock.calls).toEqual([
            [`mine`, true],
            [`theirs`, false],
        ]);
    });

    it(`asks before turning somebody else's on, including by following a sandbox that lands`, async () => {
        const pressed = pressAutoLand(`theirs`, null, true);
        expect(foreignAsk.value?.kind).toBe(`autoLand`);
        expect(setAutoLand).not.toHaveBeenCalled();
        answerForeign(true);
        await pressed;
        expect(setAutoLand).toHaveBeenCalledWith(`theirs`, null);
    });

    it(`writes nothing on a no`, async () => {
        const pressed = pressAutoLand(`theirs`, true, true);
        answerForeign(false);
        await pressed;
        expect(setAutoLand).not.toHaveBeenCalled();
    });
});
