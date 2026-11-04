import type { SealOpen, SealView } from "@intentic/sandbox-contract/schemas/seal";
import {
    addedReaders,
    firstName,
    isOpener,
    isSealed,
    openingsOf,
    openingStanding,
    pillOffered,
    readOnlyUntil,
    readsAsReader,
    sealedTitle,
    sealLabel,
} from "./sealView";

// How one private conversation reads to the person looking, from the seal its summary carries (schemas/seal.ts).

const ANNA = { email: `anna@acme.dev`, name: `Anna Berg` };
const OLA = { email: `ola@acme.dev`, name: `Ola Nordmann` };
const ME = `me@acme.dev`;

const opening = (over: Partial<SealOpen>): SealOpen => ({ id: `o1`, email: `owner@acme.dev`, at: 1, until: 2, reason: `the main line is red for everyone`, ...over });

describe(`sealView`, () => {
    it(`tells a sealed card from a conversation the reader reads, and from one nobody sealed`, () => {
        expect(isSealed({ seal: { sealed: true, readers: [ANNA] } })).toBe(true);
        expect(isSealed({ seal: { via: `reader`, readers: [ANNA] } })).toBe(false);
        expect(isSealed({})).toBe(false);
        expect(isSealed(undefined)).toBe(false);
        expect(sealedTitle()).toBe(`Private conversation`);
    });

    it(`is read-only until its end only for someone shown it for a day or who opened it without asking`, () => {
        expect(readOnlyUntil({ seal: { via: `grant`, until: 50 } })).toBe(50);
        expect(readOnlyUntil({ seal: { via: `open`, until: 70 } })).toBe(70);
        expect(readOnlyUntil({ seal: { via: `reader`, until: 70 } })).toBeUndefined();
        expect(readOnlyUntil({ seal: { sealed: true } })).toBeUndefined();
        expect(readsAsReader({ seal: { via: `reader` } })).toBe(true);
        expect(readsAsReader({ seal: { via: `grant`, until: 1 } })).toBe(false);
    });

    it(`names a person by their first name, or their address up to the @`, () => {
        expect(firstName(ANNA)).toBe(`Anna`);
        expect(firstName({ email: `jo@acme.dev` })).toBe(`jo`);
        expect(firstName({ email: `jo@acme.dev`, name: `  ` })).toBe(`jo`);
    });

    it(`says who reads it from where the reader stands`, () => {
        const mine: SealView = { via: `reader`, readers: [{ email: ME }, OLA] };
        expect(sealLabel(undefined, ME)).toBe(`Shared`);
        expect(sealLabel({ via: `reader`, readers: [{ email: ME }] }, ME)).toBe(`Private · only you`);
        expect(sealLabel(mine, `ME@acme.dev`)).toBe(`Private · you and Ola`);
        expect(sealLabel({ via: `reader`, readers: [{ email: ME }, OLA, ANNA] }, ME)).toBe(`Private · you and 2 others`);
        expect(addedReaders(mine)).toEqual([OLA]);
    });

    it(`offers the pill wherever something new can be private, and on a private one whatever the house says`, () => {
        expect(pillOffered({ mode: `everyone` }, undefined)).toBe(false);
        expect(pillOffered({ mode: `everyone` }, { via: `reader`, readers: [ANNA] })).toBe(true);
        expect(pillOffered({ mode: `chooses` }, undefined)).toBe(true);
        expect(pillOffered(undefined, undefined)).toBe(false);
    });

    it(`reads each opening by where it stands, newest first, and knows its own opener`, () => {
        const refused = opening({ id: `r`, at: 3, refusedBy: { email: OLA.email, at: 4 }, pending: true });
        const pending = opening({ id: `p`, at: 5, pending: true });
        const opened = opening({ id: `o`, at: 1 });
        expect([refused, pending, opened].map(openingStanding)).toEqual([`refused`, `pending`, `opened`]);
        expect(openingsOf({ opens: [opened, refused, pending] }).map((open) => open.id)).toEqual([`p`, `r`, `o`]);
        expect(isOpener(pending, `OWNER@acme.dev`)).toBe(true);
        expect(isOpener(pending, ME)).toBe(false);
        expect(isOpener(undefined, ME)).toBe(false);
    });
});
