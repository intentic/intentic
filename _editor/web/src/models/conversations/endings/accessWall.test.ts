import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { accessWallOf, type WallFacts } from "./accessWall";

// When a person is truly needed after a refusal for access: only where no account of the provider can serve. Anywhere
// else the sandbox moves the conversation by itself, or a person already has.

const OFF: AccountState = { kind: `blocked`, fix: `admin`, reason: `Your organization has disabled Claude Code.` };
const READY: AccountState = { kind: `ready`, room: 60 };
const facts = (over: Partial<WallFacts> = {}): WallFacts => ({
    failureCode: `claude-not-entitled`,
    provider: `claude`,
    serving: { id: `work`, state: OFF },
    accounts: [{ id: `work`, label: `Work`, state: OFF }],
    elsewhere: false,
    ...over,
});

describe(`accessWallOf`, () => {
    it(`stands where the refused account is the only one, naming it`, () => {
        expect(accessWallOf(facts())).toEqual({ provider: `claude`, account: `Work`, elsewhere: false });
        expect(accessWallOf(facts({ failureCode: `account-not-entitled`, elsewhere: true }))).toMatchObject({ elsewhere: true });
    });

    it(`stands down where another account can serve, even one nothing has measured`, () => {
        expect(accessWallOf(facts({ accounts: [{ id: `work`, label: `Work`, state: OFF }, { id: `home`, label: `Home`, state: READY }] }))).toBeUndefined();
        expect(accessWallOf(facts({ accounts: [{ id: `work`, label: `Work`, state: OFF }, { id: `home`, label: `Home`, state: { kind: `unknown` } }] }))).toBeUndefined();
    });

    it(`stands down for any other failure, and once the next turn's account can serve`, () => {
        expect(accessWallOf(facts({ failureCode: `rate_limit` }))).toBeUndefined();
        expect(accessWallOf(facts({ failureCode: undefined }))).toBeUndefined();
        expect(accessWallOf(facts({ serving: { id: `work`, state: READY } }))).toBeUndefined();
    });

    // A spent account beside the refused one is no way on today: the wall stands, and connecting is still the fix.
    it(`counts a spent account as none`, () => {
        const spent: AccountState = { kind: `spent` };
        expect(accessWallOf(facts({ accounts: [{ id: `work`, label: `Work`, state: OFF }, { id: `home`, label: `Home`, state: spent }] }))).toMatchObject({
            account: `Work`,
        });
    });
});
