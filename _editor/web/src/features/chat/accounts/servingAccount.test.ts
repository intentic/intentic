import { type AccountState, MINTED_PROVIDERS } from "@intentic/sandbox-contract";
import { autoAccount, servingAccount } from "./servingAccount";

// Which account the next turn runs on, as the daemon will place it: the one answer the picker's highlight is drawn
// from, so it can never tick one account while the turn goes to another.

const ready = (room: number): AccountState => ({ kind: `ready`, room });
const SPENT: AccountState = { kind: `spent`, reopensAt: 1_900_000_000 };
const UNREAD: AccountState = { kind: `unknown` };
const SEATLESS: AccountState = { kind: `blocked`, fix: `admin`, reason: `Your organization has disabled Claude subscription access.` };
const SIGNED_OUT: AccountState = { kind: `blocked`, fix: `reconnect`, reason: `sign-in expired` };

const row = (id: string, state: AccountState) => ({ id, state });

// A runtime that takes its first connected account, whatever it has left (harness-credentials.ts, minted keys).
const FIRST_TAKER = MINTED_PROVIDERS[0]!;

// The reported bug: the org-disabled account listed first was ticked, and the turn ran on another.
const FLEET = [row(`work`, SEATLESS), row(`personal`, ready(40)), row(`spare`, ready(70))];

describe(`a turn naming no account`, () => {
    it(`runs on Claude's roomiest ready account, never on the first row by position`, () => {
        expect(autoAccount(`claude`, FLEET)?.id).toBe(`spare`);
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false })).toEqual({ id: `spare`, byAllowance: true });
    });

    it(`falls from room to unread to spent, and to a blocked account only when that is all there is`, () => {
        expect(autoAccount(`claude`, [row(`a`, SEATLESS), row(`b`, SPENT), row(`c`, UNREAD)])?.id).toBe(`c`);
        expect(autoAccount(`claude`, [row(`a`, SEATLESS), row(`b`, SPENT)])?.id).toBe(`b`);
        expect(autoAccount(`claude`, [row(`a`, SIGNED_OUT), row(`b`, SEATLESS)])?.id).toBe(`a`);
    });

    it(`keeps the provider's own order between equals, the order the daemon breaks ties by`, () => {
        expect(autoAccount(`claude`, [row(`first`, ready(50)), row(`second`, ready(50))])?.id).toBe(`first`);
        expect(autoAccount(`cursor`, [row(`first`, UNREAD), row(`second`, UNREAD)])?.id).toBe(`first`);
    });

    it(`skips a Cursor account spent on the model, as its ledger of refusals does`, () => {
        expect(autoAccount(`cursor`, [row(`refused`, SPENT), row(`clear`, UNREAD)])?.id).toBe(`clear`);
    });

    it(`runs on the first connected account where the runtime weighs nothing, and says it was not placed by allowance`, () => {
        const accounts = [row(`first`, SPENT), row(`second`, ready(90))];
        expect(autoAccount(FIRST_TAKER, accounts)?.id).toBe(`first`);
        expect(servingAccount(FIRST_TAKER, accounts, { account: undefined, named: false })).toEqual({ id: `first`, byAllowance: false });
    });

    it(`has nowhere to run before any account is listed`, () => {
        expect(servingAccount(`claude`, [], { account: undefined, named: false })).toBeUndefined();
    });
});

describe(`a turn naming its account`, () => {
    it(`runs there whatever its state: a pick of a refused account is an attempt on it`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `work`, named: true })).toEqual({ id: `work`, byAllowance: false });
    });

    it(`runs nowhere when the account is gone from the list, since the daemon refuses the turn`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `disconnected`, named: true })).toBeUndefined();
        expect(servingAccount(`claude`, FLEET, { account: `disconnected`, named: false })).toBeUndefined();
    });
});

describe(`a turn left to the conversation's own account`, () => {
    it(`stays on it while it can serve, and while it is spent (the limit move is the refusal's to make)`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `personal`, named: false })).toEqual({ id: `personal`, byAllowance: false });
        const spent = [row(`mine`, SPENT), row(`other`, ready(80))];
        expect(servingAccount(`claude`, spent, { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
    });

    it(`moves to the roomiest ready account once an organisation took the seat`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `work`, named: false })).toEqual({ id: `spare`, byAllowance: true });
    });

    it(`is held on the seatless account when no other one has proven room`, () => {
        const nowhere = [row(`work`, SEATLESS), row(`unread`, UNREAD), row(`spent`, SPENT)];
        expect(servingAccount(`claude`, nowhere, { account: `work`, named: false })).toEqual({ id: `work`, byAllowance: false });
    });

    it(`is held on an expired sign-in, which reconnecting fixes in place`, () => {
        const expired = [row(`mine`, SIGNED_OUT), row(`other`, ready(80))];
        expect(servingAccount(`claude`, expired, { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
    });

    it(`is never moved off a seatless account on a runtime whose accounts carry no seat`, () => {
        const minted = [row(`mine`, SEATLESS), row(`other`, ready(80))];
        expect(servingAccount(FIRST_TAKER, minted, { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
    });
});
