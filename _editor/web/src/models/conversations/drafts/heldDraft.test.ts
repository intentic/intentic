import type { ComposerDraft } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { answered, type HeldDraft, joinedWords, pulled } from "./heldDraft";

// The rules this browser's copy of a draft is kept against the sandbox's by: no edit is dropped unseen, and words
// already sent or cleared elsewhere never come back.

const sandbox = (conversationId: string, text: string, revision: number, since = 1_000): ComposerDraft => ({ conversationId, text, since, revision });

// A copy agreed with the sandbox at `revision` holding `agreed`, now holding `text` (pending when the two differ).
const copy = (conversationId: string, text: string, agreed?: { revision: number; text: string }, editedAt = 5): HeldDraft => ({
    conversationId,
    text,
    attachments: [],
    since: 1_000,
    editedAt,
    synced: agreed === undefined ? undefined : { revision: agreed.revision, text: agreed.text, paths: [] },
    pending: agreed === undefined || agreed.text !== text,
});

describe(`pulled`, () => {
    test(`takes the sandbox's newer words where this copy holds no edit of its own`, () => {
        const next = pulled(new Map([[`c1`, copy(`c1`, `fix`, { revision: 1, text: `fix` })]]), { drafts: [sandbox(`c1`, `fix the login`, 2)], revision: 2 }, 9);
        expect(next.get(`c1`)).toMatchObject({ text: `fix the login`, synced: { revision: 2 }, pending: false });
    });

    test(`keeps an edit made here for the next write, whatever the sandbox holds`, () => {
        const mine = copy(`c1`, `fix it now`, { revision: 1, text: `fix` });
        const next = pulled(new Map([[`c1`, mine]]), { drafts: [sandbox(`c1`, `fix the login`, 2)], revision: 2 }, 9);
        expect(next.get(`c1`)).toBe(mine);
    });

    test(`never goes back to an older read than the copy already agreed with`, () => {
        const mine = copy(`c1`, `fix the login`, { revision: 3, text: `fix the login` });
        const next = pulled(new Map([[`c1`, mine]]), { drafts: [sandbox(`c1`, `fix`, 2)], revision: 2 }, 9);
        expect(next.get(`c1`)).toBe(mine);
    });

    test(`drops a copy the sandbox let go of (sent, or cleared on another device), and only one agreed before the read`, () => {
        const sent = copy(`c1`, `fix`, { revision: 1, text: `fix` });
        const writtenSince = copy(`c2`, `later`, { revision: 7, text: `later` });
        const next = pulled(
            new Map([
                [`c1`, sent],
                [`c2`, writtenSince],
            ]),
            { drafts: [], revision: 5 },
            9,
        );
        expect([...next.keys()]).toEqual([`c2`]);
    });

    test(`writes a copy the sandbox never held (an older sandbox's, or an offline one's), rather than dropping it`, () => {
        const never = { ...copy(`c1`, `typed offline`), pending: false };
        expect(pulled(new Map([[`c1`, never]]), { drafts: [], revision: 5 }, 9).get(`c1`)).toMatchObject({ text: `typed offline`, pending: true });
    });

    test(`keeps both when words written here before this browser read the sandbox meet other words there`, () => {
        const offline = copy(`c1`, `typed offline`);
        expect(pulled(new Map([[`c1`, offline]]), { drafts: [sandbox(`c1`, `typed on the phone`, 3)], revision: 3 }, 9).get(`c1`)).toMatchObject({
            text: `typed on the phone\n\ntyped offline`,
            synced: { revision: 3, text: `typed on the phone` },
            pending: true,
        });
    });

    test(`keeps words typed here after the sandbox let the draft go, as a draft of their own`, () => {
        const typedOn = copy(`c1`, `fix, and the logout`, { revision: 1, text: `fix` });
        expect(pulled(new Map([[`c1`, typedOn]]), { drafts: [], revision: 5 }, 9).get(`c1`)).toMatchObject({ text: `fix, and the logout`, synced: undefined });
    });
});

describe(`answered`, () => {
    test(`agrees with the sandbox once the words it wrote are the words here`, () => {
        const sent = copy(`c1`, `fix it`, { revision: 1, text: `fix` });
        expect(answered(sent, sent, { draft: sandbox(`c1`, `fix it`, 2) })).toMatchObject({ synced: { revision: 2, text: `fix it` }, pending: false });
    });

    test(`stays pending when the person typed on while the write was out`, () => {
        const sent = copy(`c1`, `fix it`, { revision: 1, text: `fix` }, 5);
        const now = { ...sent, text: `fix it now`, editedAt: 6 };
        expect(answered(now, sent, { draft: sandbox(`c1`, `fix it`, 2) })).toMatchObject({ text: `fix it now`, synced: { revision: 2 }, pending: true });
    });

    test(`keeps both sets of words when another window or device wrote over the revision this copy was edited from`, () => {
        const sent = copy(`c1`, `fix the logout`, { revision: 1, text: `fix` });
        const next = answered(sent, sent, { draft: sandbox(`c1`, `fix the login`, 2), conflict: true });
        expect(next).toMatchObject({ text: `fix the login\n\nfix the logout`, synced: { revision: 2 }, pending: true });
    });

    test(`takes the newer words when this copy had nothing of its own since it last agreed`, () => {
        const sent = copy(`c1`, ``, { revision: 1, text: `fix` });
        expect(answered(sent, sent, { draft: sandbox(`c1`, `fix the login`, 2), conflict: true })).toMatchObject({ text: `fix the login`, pending: false });
    });

    test(`lets words go that were sent elsewhere since, so a sent message never comes back as a draft`, () => {
        const stale = copy(`c1`, `fix`, { revision: 1, text: `fix` });
        expect(answered({ ...stale, pending: true }, { ...stale, pending: true }, { conflict: true })).toBeUndefined();
    });

    test(`a clear the sandbox took leaves nothing, unless the person typed again meanwhile`, () => {
        const clearing = copy(`c1`, ``, { revision: 1, text: `fix` }, 5);
        expect(answered(clearing, clearing, {})).toBeUndefined();
        expect(answered({ ...clearing, text: `new words`, editedAt: 6 }, clearing, {})).toMatchObject({ text: `new words`, synced: undefined, pending: true });
    });
});

describe(`joinedWords`, () => {
    const words = (text: string, paths: readonly string[] = []) => ({ text, attachments: paths.map((path) => ({ name: path, path })) });

    test(`keeps the longer when one already holds the other, so a copy that only typed on is not doubled`, () => {
        expect(joinedWords(words(`fix the login`), words(`fix the login page`)).text).toBe(`fix the login page`);
    });

    test(`joins two different sets of words, theirs first, and every file once`, () => {
        const joined = joinedWords(words(`theirs`, [`a.png`]), words(`mine`, [`a.png`, `b.png`]));
        expect({ text: joined.text, paths: joined.attachments.map((file) => file.path) }).toEqual({ text: `theirs\n\nmine`, paths: [`a.png`, `b.png`] });
    });
});
