// The question before landing somebody else's conversation: who it is asked about, and that a land waits on its answer.
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
jest.mock("../useAgents", () => ({ useAgents: () => ({ agentById: (id: string) => stub.cards.get(id) }) }));

const { answerForeignLand, asksBeforeLand, clearedToLand, foreignLandAsk, foreignOwner } = await import("./foreignLand");

afterEach(() => {
    answerForeignLand(false);
    stub.cards.clear();
});

describe(`foreignOwner`, () => {
    it(`names the owner only when it is somebody else`, () => {
        expect(foreignOwner({ owner: { email: `anna@example.com` } }, `me@example.com`, [])?.email).toBe(`anna@example.com`);
        expect(foreignOwner({ owner: { email: `ME@example.com` } }, `me@example.com`, [])).toBeUndefined();
    });

    it(`has nobody to ask about for an unowned card, a missing card, or a reader with no address`, () => {
        expect(foreignOwner({}, `me@example.com`, [])).toBeUndefined();
        expect(foreignOwner(undefined, `me@example.com`, [])).toBeUndefined();
        expect(foreignOwner({ owner: { email: `anna@example.com` } }, undefined, [])).toBeUndefined();
    });
});

describe(`clearedToLand`, () => {
    it(`lets the reader's own conversation through without asking`, async () => {
        stub.cards.set(`mine`, { owner: { email: `me@example.com` } });
        await expect(clearedToLand(`mine`, undefined)).resolves.toBe(true);
        expect(foreignLandAsk.value).toBeUndefined();
    });

    it(`holds somebody else's until the reader answers, naming them and the work`, async () => {
        stub.cards.set(`theirs`, { owner: { email: `anna@example.com` }, title: `Fix signup`, diff: { files: 3 } });
        const cleared = clearedToLand(`theirs`, undefined);
        expect(foreignLandAsk.value).toMatchObject({ id: `theirs`, title: `Fix signup`, files: 3, owner: { name: `Anna Kowalska`, short: `Anna` } });
        answerForeignLand(true);
        await expect(cleared).resolves.toBe(true);
        expect(foreignLandAsk.value).toBeUndefined();
    });

    it(`answers no on cancel, and for a question a second press replaced`, async () => {
        stub.cards.set(`theirs`, { owner: { email: `anna@example.com` } });
        const first = clearedToLand(`theirs`, undefined);
        const second = clearedToLand(`theirs`, undefined);
        await expect(first).resolves.toBe(false);
        answerForeignLand(false);
        await expect(second).resolves.toBe(false);
    });

    it(`reads a card in another box from that box's roster`, () => {
        expect(asksBeforeLand(`far`, `box-2`)).toBe(true);
        expect(asksBeforeLand(`far`, undefined)).toBe(false);
    });
});
