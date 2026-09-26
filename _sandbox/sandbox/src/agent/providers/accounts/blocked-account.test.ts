import type { AccountUsage, OauthAccount, ProviderRefusal } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { SeatRefusal } from "../../../runtimes/claude/claude-seats.js";
import type { ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { offBlockedAccount } from "./blocked-account.js";

// Which turns are moved off the account their conversation remembers, and which are left where routing points. The
// planning side (the move recorded, the refusal held) is turn-plan.test.ts's; the whole path is agent.routes'.

const reading = (utilization: number): AccountUsage => ({ windows: [{ kind: "five_hour", utilization, gates: "all" }], measuredAt: Date.now() });

const deps = (params: {
    readonly accounts: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly seats?: Record<string, SeatRefusal>;
    readonly refusal?: ProviderRefusal;
}): ServiceabilityDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...params.accounts] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => params.seats ?? {} }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", {
        read: async () => (params.refusal === undefined ? {} : { claude: params.refusal }),
    }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
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
