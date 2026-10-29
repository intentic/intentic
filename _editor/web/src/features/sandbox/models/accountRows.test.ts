import { type AccountReader, ambiguousLabels, connectorNote, connectWays, identityNote, mayChangeAccount, rowNote, type WayFacts } from "./accountRows";

// One account's row in a provider's panel: who connected it, which presses the reader gets on it, and the ways in they may
// take. Full access keeps every press; someone given AI accounts of their own changes only the accounts they connected and
// never sees a way the sandbox would refuse them.

const FULL: AccountReader = { full: true, ownAccounts: false, email: `ada@acme.dev` };
const OWN: AccountReader = { full: false, ownAccounts: true, email: `jo@acme.dev` };
const NEITHER: AccountReader = { full: false, ownAccounts: false, email: `jo@acme.dev` };

describe(`connectorNote`, () => {
    it(`names the reader as you, whatever the case of the address`, () => {
        expect(connectorNote(`Jo@Acme.dev`, `jo@acme.dev`)).toBe(`Connected by you`);
    });

    it(`names anyone else by their address`, () => {
        expect(connectorNote(`jo@acme.dev`, `ada@acme.dev`)).toBe(`Connected by jo@acme.dev`);
        expect(connectorNote(`jo@acme.dev`, undefined)).toBe(`Connected by jo@acme.dev`);
    });

    it(`says nothing where nobody was recorded`, () => {
        expect(connectorNote(undefined, `ada@acme.dev`)).toBeUndefined();
        expect(connectorNote(` `, `ada@acme.dev`)).toBeUndefined();
    });
});

describe(`mayChangeAccount`, () => {
    it(`lets Full access change every account, recorded or not`, () => {
        expect(mayChangeAccount({ connectedBy: `jo@acme.dev` }, FULL)).toBe(true);
        expect(mayChangeAccount({}, FULL)).toBe(true);
    });

    it(`lets someone with AI accounts of their own change only the ones they connected`, () => {
        expect(mayChangeAccount({ connectedBy: `JO@acme.dev` }, OWN)).toBe(true);
        expect(mayChangeAccount({ connectedBy: `ada@acme.dev` }, OWN)).toBe(false);
        // Connected before anybody was recorded: nobody's but Full access's.
        expect(mayChangeAccount({}, OWN)).toBe(false);
    });

    it(`lets nobody else change any, their own address or not`, () => {
        expect(mayChangeAccount({ connectedBy: `jo@acme.dev` }, NEITHER)).toBe(false);
        expect(mayChangeAccount({ connectedBy: `jo@acme.dev` }, { ...OWN, email: undefined })).toBe(false);
    });
});

describe(`connectWays`, () => {
    // Grok's three ways in: its own xAI account, Grok Build's sign-in, and SuperGrok under Claude Code.
    const grok = (may: WayFacts[`may`], empty = true): WayFacts => ({
        native: { name: `xAI account`, addable: true },
        doors: [{ door: `build`, name: `Grok Build sign-in` }],
        routed: `SuperGrok`,
        may,
        empty,
    });

    it(`offers Full access every way in, each named for what it connects`, () => {
        expect(connectWays(grok({ native: true, routed: true })).map((way) => [way.key, way.label])).toEqual([
            [`native:`, `Connect xAI account`],
            [`native:build`, `Connect Grok Build sign-in`],
            [`routed:`, `Connect SuperGrok`],
        ]);
    });

    it(`draws no translator way for someone who may only start a provider's own sign-in`, () => {
        const ways = connectWays(grok({ native: true, routed: false }));
        expect(ways.map((way) => way.via)).toEqual([`native`, `native`]);
        expect(ways.some((way) => way.via === `routed`)).toBe(false);
    });

    it(`draws nothing at all where the reader may start no sign-in`, () => {
        expect(connectWays(grok({ native: false, routed: false }))).toEqual([]);
        expect(connectWays({ doors: [], routed: `ChatGPT subscription`, may: { native: true, routed: false }, empty: true })).toEqual([]);
    });

    it(`calls a lone way Connect on an empty list and Add another account once it holds one`, () => {
        const claude = (empty: boolean): WayFacts => ({ native: { name: `Claude account`, addable: true }, doors: [], may: { native: true, routed: true }, empty });
        expect(connectWays(claude(true)).map((way) => way.label)).toEqual([`Connect`]);
        expect(connectWays(claude(false)).map((way) => way.label)).toEqual([`Add another account`]);
    });

    it(`keeps the other buttons' names once Grok's single default account is in`, () => {
        const linked = { ...grok({ native: true, routed: false }, false), native: { name: `xAI account`, addable: false } };
        expect(connectWays(linked).map((way) => way.label)).toEqual([`Connect Grok Build sign-in`]);
    });
});

describe(`a row's quiet facts`, () => {
    it(`joins what there is with a middle dot, the connector after who it signs in as`, () => {
        const account = { label: `Claude Pro`, email: `work@acme.dev`, organization: `Acme`, connectedAt: 0 };
        expect(rowNote([undefined, identityNote(account, new Set()), connectorNote(`jo@acme.dev`, `ada@acme.dev`)])).toBe(
            `work@acme.dev · Acme · Connected by jo@acme.dev`,
        );
        expect(rowNote([undefined, ``])).toBeUndefined();
    });

    it(`tells two accounts of one name apart by when they connected, where nothing else does`, () => {
        const now = Date.UTC(2026, 9, 29);
        const accounts = [
            { label: `Claude`, connectedAt: now - 2 * 86_400_000 },
            { label: `Claude`, connectedAt: now },
        ];
        const ambiguous = ambiguousLabels(accounts);
        expect(ambiguous.has(`Claude`)).toBe(true);
        expect(identityNote(accounts[0]!, ambiguous, now)).toMatch(/^connected /);
        expect(identityNote({ label: `Solo`, connectedAt: now }, ambiguous, now)).toBeUndefined();
    });
});
