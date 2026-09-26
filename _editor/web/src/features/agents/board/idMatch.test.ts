import { handleOf, idMatchOf } from "./idMatch";

// Pins which queries read as a handle and what each finds: every spelling of an id names its card whole, a joined piece
// of one finds it without claiming it, and a bare word never does, since ids are made of words a transcript uses.

const card = { id: `crisp-basin-z86j`, branch: `agent/crisp-basin-z86j`, sessionId: `4F1C2A9E-0B7D-4E21-9C3A-5D6E7F809A1B` };
const found = (query: string) => {
    const handle = handleOf(query);
    return handle === undefined ? `words` : (idMatchOf(card, handle) ?? `none`);
};
const exactly = (text: string) => ({ text, mark: text.toLowerCase(), exact: true });

describe(`the filter's id tier`, () => {
    it(`names the card whole from its id, its branch, a link to its page, its worktree and its session id, in any case`, () => {
        expect([
            found(`crisp-basin-z86j`),
            found(`  Crisp-Basin-Z86J `),
            found(`agent/crisp-basin-z86j`),
            found(`https://app.intentic.dev/agents/crisp-basin-z86j?sandbox=sbx-1#top`),
            found(`/work/.worktrees/crisp-basin-z86j/`),
            found(`4f1c2a9e-0b7d-4e21-9c3a-5d6e7f809a1b`),
        ]).toEqual([
            exactly(`crisp-basin-z86j`),
            exactly(`crisp-basin-z86j`),
            exactly(`crisp-basin-z86j`),
            exactly(`crisp-basin-z86j`),
            exactly(`crisp-basin-z86j`),
            exactly(card.sessionId),
        ]);
    });

    it(`finds the card from a joined piece of its id, marking the piece, without naming it`, () => {
        expect([found(`crisp-basin`), found(`basin-z8`), found(`agent/crisp-b`)]).toEqual([
            { text: `crisp-basin-z86j`, mark: `crisp-basin`, exact: false },
            { text: `crisp-basin-z86j`, mark: `basin-z8`, exact: false },
            { text: `crisp-basin-z86j`, mark: `crisp-b`, exact: false },
        ]);
    });

    it(`reads a phrase as words only, and finds nothing from a bare word of the id or a piece too short or not in it`, () => {
        expect([found(`crisp basin`), found(`basin`), found(`z86j`), found(`-b`), found(`crisp-otter`), found(`agent/basin`)]).toEqual([
            `words`,
            `none`,
            `none`,
            `none`,
            `none`,
            `none`,
        ]);
    });

    it(`names an id joined by underscores whole, and finds it from an underscored piece`, () => {
        const snake = { id: `cnv_Checkout_stripe` };
        const of = (query: string) => {
            const handle = handleOf(query);
            return handle === undefined ? undefined : idMatchOf(snake, handle);
        };
        expect([of(`cnv_checkout_stripe`), of(`checkout_str`), of(`checkout`)]).toEqual([
            exactly(`cnv_Checkout_stripe`),
            { text: `cnv_Checkout_stripe`, mark: `checkout_str`, exact: false },
            undefined,
        ]);
    });

    it(`names a card by a branch of its own spelling, which no id is`, () => {
        const handle = handleOf(`feature/Login-Fix`);
        expect(handle === undefined ? undefined : idMatchOf({ id: `swift-otter-k9m2`, branch: `feature/login-fix` }, handle)).toEqual(
            exactly(`feature/login-fix`),
        );
    });
});
