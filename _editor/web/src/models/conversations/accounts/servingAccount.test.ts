import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { MINTED_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { autoAccount, servingAccount } from "./servingAccount";

// Which account the next turn runs on, as the daemon will place it: the one answer the picker's highlight is drawn
// from, so it can never tick one account while the turn goes to another.

const ready = (room: number): AccountState => ({ kind: `ready`, room });
const SPENT: AccountState = { kind: `spent`, reopensAt: 1_900_000_000 };
const UNREAD: AccountState = { kind: `unknown` };
const SEATLESS: AccountState = { kind: `blocked`, fix: `admin`, reason: `Your organization has disabled Claude subscription access.` };
const SIGNED_OUT: AccountState = { kind: `blocked`, fix: `reconnect`, reason: `sign-in expired` };

const row = (id: string, state: AccountState) => ({ id, state });

// A minted key's provider (Meta, Z.ai): it once took its first connected account, whatever it had left.
const MINTED = MINTED_PROVIDERS[0]!;

// The reported bug: the org-disabled account listed first was ticked, and the turn ran on another.
const FLEET = [row(`work`, SEATLESS), row(`personal`, ready(40)), row(`spare`, ready(70))];

describe(`a turn naming no account`, () => {
    it(`runs on Claude's roomiest ready account, never on the first row by position`, () => {
        expect(autoAccount(FLEET)?.id).toBe(`spare`);
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false })).toEqual({ id: `spare`, byAllowance: true });
    });

    it(`falls from room to unread to spent, and to a blocked account only when that is all there is`, () => {
        expect(autoAccount([row(`a`, SEATLESS), row(`b`, SPENT), row(`c`, UNREAD)])?.id).toBe(`c`);
        expect(autoAccount([row(`a`, SEATLESS), row(`b`, SPENT)])?.id).toBe(`b`);
        expect(autoAccount([row(`a`, SIGNED_OUT), row(`b`, SEATLESS)])?.id).toBe(`a`);
    });

    it(`keeps the provider's own order between equals, the order the daemon breaks ties by`, () => {
        expect(autoAccount([row(`first`, ready(50)), row(`second`, ready(50))])?.id).toBe(`first`);
        expect(autoAccount([row(`first`, UNREAD), row(`second`, UNREAD)])?.id).toBe(`first`);
    });

    it(`skips a Devin account whose weekly quota was refused, as the daemon's unpinned pick does`, () => {
        const accounts = [row(`first`, SPENT), row(`second`, UNREAD), row(`third`, UNREAD)];
        expect(autoAccount(accounts)?.id).toBe(`second`);
        expect(servingAccount(`devin`, accounts, { account: undefined, named: false })).toEqual({ id: `second`, byAllowance: true });
    });

    it(`skips a Cursor account spent on the model, as its ledger of refusals does`, () => {
        expect(autoAccount([row(`refused`, SPENT), row(`clear`, UNREAD)])?.id).toBe(`clear`);
    });

    it(`places a minted key's turn by the same rule as every provider whose accounts can be picked`, () => {
        const accounts = [row(`first`, SPENT), row(`second`, ready(90))];
        expect(autoAccount(accounts)?.id).toBe(`second`);
        expect(servingAccount(MINTED, accounts, { account: undefined, named: false })).toEqual({ id: `second`, byAllowance: true });
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
    it(`stays on it while it can serve`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `personal`, named: false })).toEqual({ id: `personal`, byAllowance: false });
    });

    // The 2026-10-29 Devin chat, refused twice on a spent account with two beside it that nothing had refused.
    it(`moves off a spent one where the daemon's move would land, pinned or not, and stays with nowhere to go`, () => {
        expect(servingAccount(`claude`, [row(`mine`, SPENT), row(`other`, ready(80))], { account: `mine`, named: false })).toEqual({ id: `other`, byAllowance: true });
        expect(servingAccount(`claude`, [row(`mine`, SPENT), row(`line`, ready(0))], { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
        // A reading that went stale is no refusal (account-moves.ts, the shinobi-society audit of 2026-11-17).
        expect(servingAccount(`claude`, [row(`mine`, SPENT), row(`unread`, UNREAD)], { account: `mine`, named: false })).toEqual({ id: `unread`, byAllowance: true });
        expect(servingAccount(`devin`, [row(`mine`, SPENT), row(`unread`, UNREAD)], { account: `mine`, named: false })).toEqual({ id: `unread`, byAllowance: true });
    });

    it(`moves to the roomiest ready account once an organisation took the seat`, () => {
        expect(servingAccount(`claude`, FLEET, { account: `work`, named: false })).toEqual({ id: `spare`, byAllowance: true });
    });

    it(`is held on the seatless account when no other one can serve`, () => {
        const nowhere = [row(`work`, SEATLESS), row(`line`, ready(0)), row(`unread`, UNREAD), row(`spent`, SPENT)];
        expect(servingAccount(`claude`, nowhere, { account: `work`, named: false })).toEqual({ id: `work`, byAllowance: false });
        expect(servingAccount(`claude`, [row(`work`, SEATLESS), row(`spent`, SPENT)], { account: `work`, named: false })).toEqual({ id: `work`, byAllowance: false });
    });

    it(`moves to an unread account once every account with a reading is refused`, () => {
        const stale = [row(`work`, SEATLESS), row(`unread`, UNREAD), row(`spent`, SPENT)];
        expect(servingAccount(`claude`, stale, { account: `work`, named: false })).toEqual({ id: `unread`, byAllowance: true });
    });

    it(`is held on an expired sign-in, which reconnecting fixes in place`, () => {
        const expired = [row(`mine`, SIGNED_OUT), row(`other`, ready(80))];
        expect(servingAccount(`claude`, expired, { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
    });

    it(`moves any pickable provider's account an organisation refused outright, as the daemon's blocked-account move does`, () => {
        const minted = [row(`mine`, SEATLESS), row(`other`, ready(80))];
        expect(servingAccount(MINTED, minted, { account: `mine`, named: false })).toEqual({ id: `other`, byAllowance: true });
    });

    it(`never moves a routed provider's sign-in, which the translator balances itself`, () => {
        expect(servingAccount(`kimi`, [row(`mine`, SPENT), row(`other`, ready(80))], { account: `mine`, named: false })).toEqual({ id: `mine`, byAllowance: false });
    });
});

// The daemon places a turn naming no account with what already runs on each account counted (placement.ts), which no
// prediction here can see: while children crowded the account renewing first, the turn went to the next one and the
// picker still ticked the first (2026-11-15, -17). Where the daemon answers, its pick is the tick.
describe(`where the daemon says it places a turn naming no account`, () => {
    it(`is the account ticked, over the one the rule here would rank first`, () => {
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `placed`, account: `personal` } })).toEqual({
            id: `personal`,
            byAllowance: true,
        });
    });

    it(`is predicted here while the answer is on its way, marked so the turn never names the prediction`, () => {
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `pending` } })).toEqual({
            id: `spare`,
            byAllowance: true,
            provisional: true,
        });
    });

    it(`leaves the prediction where the daemon names none, or a sandbox-wide answer this person's rows leave out`, () => {
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `placed`, account: undefined } })).toEqual({
            id: `spare`,
            byAllowance: true,
        });
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `placed`, account: `someone-else` } })).toEqual({
            id: `spare`,
            byAllowance: true,
        });
    });

    // Narrowed to this person's loop and accounts (usage.placement `narrowed`, 2026-11-19), the answer is where the turn
    // runs: a row this window has not caught up with yet is no reason to predict another.
    it(`takes an answer the daemon narrowed to this person as is, a row this window does not hold yet included`, () => {
        expect(
            servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `placed`, account: `joined-since`, narrowed: true } }),
        ).toEqual({ id: `joined-since`, byAllowance: true });
        expect(servingAccount(`claude`, FLEET, { account: undefined, named: false, placed: { kind: `placed`, account: `personal`, narrowed: true } })).toEqual({
            id: `personal`,
            byAllowance: true,
        });
    });

    it(`says nothing about a turn that names its account, or runs on its record`, () => {
        const placed = { kind: `placed`, account: `personal` } as const;
        expect(servingAccount(`claude`, FLEET, { account: `spare`, named: true, placed })).toEqual({ id: `spare`, byAllowance: false });
        expect(servingAccount(`claude`, FLEET, { account: `spare`, named: false, placed })).toEqual({ id: `spare`, byAllowance: false });
    });
});
