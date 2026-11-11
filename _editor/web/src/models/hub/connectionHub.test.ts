import { HUB_ACCOUNT_PROVIDERS, type HubHolding, type HubState } from "@intentic/sandbox-contract/schemas/connection-hub";
import { accountTarget, accountWant, holdingOf, hubNote, readyComputers, saveLabel, saveTargets, targetKey, tileWant, wantKey } from "./connectionHub";

// What a connection's row and an add form read off the hub: which computers can take one in now, which held connections
// can go there, what a row says of where its connection is kept, and what a tile or a provider asks the computer for.

const GITHUB: HubHolding = { target: { type: `card`, id: `github` }, label: `github`, want: { type: `card`, kind: `cli`, connector: `github` } };
const SIGNED_IN_MCP: HubHolding = {
    target: { type: `card`, id: `linear` },
    label: `linear`,
    reason: `It is a sign-in this sandbox renews, so another sandbox would sign it out: sign in there instead.`,
};
const STATE: HubState = {
    computers: [
        { machine: `rog`, online: true, setUp: true, locked: false },
        // Locked still takes a connection in: it waits for the next unlock there.
        { machine: `z440`, online: true, setUp: true, locked: true },
        { machine: `omen`, online: false, setUp: true },
        { machine: `laptop`, online: true, setUp: false },
    ],
    holdings: [GITHUB, SIGNED_IN_MCP, { target: { type: `account`, provider: `cursor`, id: `cur_1` }, label: `Cursor Pro`, want: { type: `account`, provider: `cursor` } }],
    failures: [],
};

describe(`readyComputers`, () => {
    it(`offers every computer that is connected and has Passwords set up, locked or not`, () => {
        expect(readyComputers(STATE)).toEqual([`rog`, `z440`]);
    });

    it(`offers none before the hub has answered`, () => {
        expect(readyComputers(undefined)).toEqual([]);
    });
});

describe(`holdingOf and saveTargets`, () => {
    it(`finds a card by its id and an account by its provider and id`, () => {
        expect(holdingOf(STATE, { type: `card`, id: `github` })).toBe(GITHUB);
        expect(holdingOf(STATE, { type: `account`, provider: `cursor`, id: `cur_1` })?.label).toBe(`Cursor Pro`);
        expect(holdingOf(STATE, { type: `account`, provider: `cursor`, id: `cur_2` })).toBeUndefined();
        expect(holdingOf(undefined, { type: `card`, id: `github` })).toBeUndefined();
    });

    it(`lets a connection that can travel go to every ready computer, and one that cannot go nowhere`, () => {
        expect(saveTargets(GITHUB, [`rog`])).toEqual([`rog`]);
        expect(saveTargets(SIGNED_IN_MCP, [`rog`])).toEqual([]);
        expect(saveTargets(undefined, [`rog`])).toEqual([]);
        expect(saveTargets(GITHUB, [])).toEqual([]);
    });
});

describe(`hubNote`, () => {
    const saved = (pending: boolean): HubHolding => ({ ...GITHUB, saved: { entry: `CONNECTION_GITHUB_AB12`, machine: `rog`, at: 1, pending } });

    it(`says where a connection was saved, and that a save still waits for the person at the computer`, () => {
        expect(hubNote(saved(false))).toBe(`Saved to rog`);
        expect(hubNote(saved(true))).toBe(`Waits for your yes on rog`);
    });

    it(`says a connection came from the computer, by name where the sandbox knows it`, () => {
        expect(hubNote({ ...GITHUB, from: { entry: `CONNECTION_GITHUB_AB12`, machine: `rog` } })).toBe(`From your computer (rog)`);
        expect(hubNote({ ...GITHUB, from: { entry: `CONNECTION_GITHUB_AB12` } })).toBe(`From your computer`);
    });

    it(`puts a save still waiting first, then where it came from, then where it was saved`, () => {
        const from = { entry: `CONNECTION_GITHUB_AB12`, machine: `z440` };
        expect(hubNote({ ...saved(true), from })).toBe(`Waits for your yes on rog`);
        expect(hubNote({ ...saved(false), from })).toBe(`From your computer (z440)`);
    });

    it(`says nothing of a connection the hub has never held`, () => {
        expect(hubNote(GITHUB)).toBeUndefined();
        expect(hubNote(undefined)).toBeUndefined();
    });
});

describe(`saveLabel`, () => {
    it(`names the one computer, and asks which when there are several`, () => {
        expect(saveLabel([`rog`])).toBe(`Save to rog`);
        expect(saveLabel([`rog`, `z440`])).toBe(`Save to your computer`);
    });
});

describe(`tileWant`, () => {
    it(`asks for a CLI connector's own card by its connector`, () => {
        expect(tileWant(`cli`, `github`, false)).toEqual({ type: `card`, kind: `cli`, connector: `github` });
        // A connector id the hub would not take as a slug is asked for as the sandbox names it.
        expect(tileWant(`cli`, `Google_Ads`, false)).toEqual({ type: `card`, kind: `cli`, connector: `google-ads` });
    });

    it(`asks for nothing on a connector that renews its sign-in, since none of its cards can be saved`, () => {
        expect(tileWant(`cli`, `google-workspace`, true)).toBeUndefined();
    });

    it(`asks for any tool server or model endpoint, and nothing for a kind tied to where it was made`, () => {
        expect(tileWant(`mcp`, `custom`, false)).toEqual({ type: `card`, kind: `mcp` });
        expect(tileWant(`endpoint`, `endpoint`, false)).toEqual({ type: `card`, kind: `endpoint` });
        expect(tileWant(`device`, `linux`, false)).toBeUndefined();
        expect(tileWant(`vpn`, `wireguard`, false)).toBeUndefined();
    });
});

describe(`accountWant and accountTarget`, () => {
    it(`asks for the account of a provider whose key does not rotate`, () => {
        expect(HUB_ACCOUNT_PROVIDERS).toEqual([`cursor`, `devin`, `zai`, `meta`]);
        for (const provider of HUB_ACCOUNT_PROVIDERS) {
            expect(accountWant(provider)).toEqual({ type: `account`, provider });
            expect(accountTarget(provider, `a1`)).toEqual({ type: `account`, provider, id: `a1` });
        }
    });

    it(`asks for nothing on a provider each sandbox signs in to itself`, () => {
        for (const provider of [`claude`, `codex`, `grok`, `kimi`, `gemini`]) {
            expect(accountWant(provider)).toBeUndefined();
            expect(accountTarget(provider, `a1`)).toBeUndefined();
        }
    });
});

describe(`ledger keys`, () => {
    it(`keeps a card's save apart from an account's of the same id, and one tile's take apart from another's`, () => {
        expect(targetKey({ type: `card`, id: `cur_1` })).not.toBe(targetKey({ type: `account`, provider: `cursor`, id: `cur_1` }));
        expect(wantKey({ type: `card`, kind: `cli`, connector: `github` })).not.toBe(wantKey({ type: `card`, kind: `cli`, connector: `sentry` }));
        expect(wantKey({ type: `card`, kind: `mcp` })).not.toBe(wantKey({ type: `card`, kind: `endpoint` }));
    });
});
