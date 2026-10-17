import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { FIRST_RECHECK_MS, type SeatProbe } from "../claude/claude-seat-check.js";
import { BACK_ON, memoryRefusals, memorySeats, scriptedSeatCheck, STILL_OFF } from "../claude/claude-seat-check.testing.js";
import type { SeatRefusal } from "../claude/claude-seats.js";
import type { ObservedSpend } from "../../../usage/observed-limits.js";
import { type BlockedAccountDeps, offBlockedAccount } from "./blocked-account.js";

type StoredCursorAccount = Awaited<ReturnType<Services["cursorStore"]["credentials"]>>[number];

// Which turns are moved off the account their conversation remembers, and which are left where routing points. The
// planning side (the move recorded, the refusal held) is turn-plan.test.ts's; the whole path is agent.routes'.

const reading = (utilization: number): AccountUsage => ({ windows: [{ kind: "five_hour", utilization, gates: "all" }], measuredAt: Date.now() });

const deps = (params: {
    readonly accounts: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly seats?: Record<string, SeatRefusal>;
    readonly refusal?: ProviderRefusal;
    // What the provider says when the marked account is re-tested; the seat is still off unless a test says otherwise.
    readonly probe?: SeatProbe;
    // Cursor's connected accounts and each one's refusal ledger.
    readonly cursor?: readonly StoredCursorAccount[];
    readonly ledger?: Record<string, ObservedSpend>;
}): BlockedAccountDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...params.accounts] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => params.seats ?? {} }),
    claudeSeatCheck: scriptedSeatCheck({
        seats: memorySeats({ ...params.seats }),
        refusals: memoryRefusals(params.refusal === undefined ? {} : { claude: params.refusal }),
        answer: () => params.probe ?? STILL_OFF,
    }).check,
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
        read: async () => (params.refusal === undefined ? {} : { claude: params.refusal }),
        onFile: async () => (params.refusal === undefined ? {} : { claude: [params.refusal] }),
    }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
    cursorStore: unstubbed<Services["cursorStore"]>("cursorStore", { credentials: async () => [...(params.cursor ?? [])] }),
    observedLimits: unstubbed<Services["observedLimits"]>("observedLimits", { spent: async (_provider, account) => params.ledger?.[account] ?? {} }),
});

// SAFETY: the rule reads only an account's id and its marks; the rest of a stored row is the store's own business.
const TWO = [
    { id: "home", label: "home" },
    { id: "spare", label: "spare" },
] as OauthAccount[];
const SEAT_OFF = { home: { at: 0, reason: "Your organization has disabled Claude Code." } };
const remembered = { provider: "claude" as const, named: undefined, remembered: "home", model: undefined };

test("an account whose seat was taken away moves to the roomiest ready account", async () => {
    expect(await offBlockedAccount(deps({ accounts: TWO, seats: SEAT_OFF, usage: { spare: reading(30) } }), remembered)).toEqual({
        kind: "move",
        from: "home",
        to: "spare",
        reason: "Your organization has disabled Claude Code.",
    });
});

test("an entitlement refusal standing on the account moves it too", async () => {
    const refusal: ProviderRefusal = { at: Date.now(), kind: "entitlement", message: "Claude Code is not enabled for this organization.", account: "home" };
    expect(await offBlockedAccount(deps({ accounts: TWO, refusal, usage: { spare: reading(30) } }), remembered)).toMatchObject({ kind: "move", to: "spare" });
});

// An unmeasured account is usable but never read as room, the same bar a limit move's destination clears.
test("with no ready account the turn is held on the refused one", async () => {
    expect(await offBlockedAccount(deps({ accounts: TWO, seats: SEAT_OFF }), remembered)).toEqual({
        kind: "held",
        account: "home",
        reason: "Your organization has disabled Claude Code.",
    });
});

test("a turn naming its account, and one with nothing remembered, are left where routing points", async () => {
    const seatless = deps({ accounts: TWO, seats: SEAT_OFF, usage: { spare: reading(30) } });
    expect(await offBlockedAccount(seatless, { ...remembered, named: "home" })).toEqual({ kind: "keep" });
    expect(await offBlockedAccount(seatless, { ...remembered, remembered: undefined })).toEqual({ kind: "keep" });
});

// Each of these has its own way on: the limit move, a reconnect in place, a routed provider's own balancing.
test("a spent account, a revoked sign-in and a routed provider are not this rule's", async () => {
    const usage = { home: reading(100), spare: reading(30) };
    expect(await offBlockedAccount(deps({ accounts: TWO, usage }), remembered)).toEqual({ kind: "keep" });
    // SAFETY: as TWO above, a row holding only the id and the revoke mark the rule reads.
    const revoked = [{ id: "home", label: "home", needsReauth: true }, TWO[1]] as OauthAccount[];
    expect(await offBlockedAccount(deps({ accounts: revoked, usage: { spare: reading(30) } }), remembered)).toEqual({ kind: "keep" });
    expect(await offBlockedAccount(deps({ accounts: TWO, seats: SEAT_OFF }), { ...remembered, provider: "codex" })).toEqual({ kind: "keep" });
});

// Turns are kept off a marked account, so no turn runs there to lift the mark: a single-account user stayed held after
// their admin turned access back on. THE FAILURE THIS PREVENTS: the mark had no way back but a turn on the account.
test("a held account whose access came back is re-tested, its mark lifted, and the turn kept on it", async () => {
    const seats = { ...SEAT_OFF };
    const probe = { answer: STILL_OFF };
    let now = Date.now();
    const { check, probes } = scriptedSeatCheck({ seats: memorySeats(seats), answer: () => probe.answer, now: () => now });
    const alone = { ...deps({ accounts: TWO }), claudeSeats: memorySeats(seats), claudeSeatCheck: check };

    expect(await offBlockedAccount(alone, remembered)).toMatchObject({ kind: "held", account: "home" });
    // Not due again yet: held without asking.
    expect(await offBlockedAccount(alone, remembered)).toMatchObject({ kind: "held", account: "home" });

    // The admin turns access back on; the next due re-test finds it.
    probe.answer = BACK_ON;
    now += 2 * FIRST_RECHECK_MS;
    expect(await offBlockedAccount(alone, remembered)).toEqual({ kind: "keep" });
    expect([probes, Object.keys(seats)]).toEqual([["home", "home"], []]);
});

test("the re-test is made only for an account the rule would move a turn off", async () => {
    const { check, probes } = scriptedSeatCheck({ seats: memorySeats({ ...SEAT_OFF }), answer: () => BACK_ON });
    const seatless = { ...deps({ accounts: TWO, seats: SEAT_OFF, usage: { spare: reading(30) } }), claudeSeatCheck: check };
    await offBlockedAccount(seatless, { ...remembered, named: "home" });
    await offBlockedAccount(deps({ accounts: TWO, usage: { home: reading(10) } }), remembered);
    expect(probes).toEqual([]);
});

// 2026-10-17: Cursor refused an account outright (`[role_forbidden]`), and the conversation kept being routed to it.
describe("a Cursor account the server refused outright", () => {
    // SAFETY: the rule reads only an account's id; the rest of a stored row is the store's own business.
    const CURSOR = [{ id: "admin" }, { id: "billable" }] as StoredCursorAccount[];
    const REFUSED: ObservedSpend = { "*": { at: Date.now(), message: "[role_forbidden] not available", refused: "entitlement" } };
    const onCursor = { provider: "cursor" as const, named: undefined, remembered: "admin", model: "composer-2.5" };

    test("moves the conversation to a live account it has not refused", async () => {
        expect(await offBlockedAccount(deps({ accounts: [], cursor: CURSOR, ledger: { admin: REFUSED } }), onCursor)).toEqual({
            kind: "move",
            from: "admin",
            to: "billable",
            reason: "[role_forbidden] not available",
        });
    });

    test("stays where it was routed when every other account is refused too, so the refusal is said at once", async () => {
        const ledger = { admin: REFUSED, billable: REFUSED };
        expect(await offBlockedAccount(deps({ accounts: [], cursor: CURSOR, ledger }), onCursor)).toEqual({ kind: "keep" });
    });

    test("leaves an account with only a spent model alone: that is the limit move's", async () => {
        const ledger = { admin: { "composer-2.5": { at: Date.now(), message: "out of usage" } } };
        expect(await offBlockedAccount(deps({ accounts: [], cursor: CURSOR, ledger }), onCursor)).toEqual({ kind: "keep" });
    });
});
