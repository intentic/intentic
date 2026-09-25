import { type AccountUsage, type OauthAccount, preferredAccount, type ProviderRefusal, type TranslatorAccounts, type UsageWindow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import type { SeatRefusal } from "../runtimes/claude/claude-seats.js";
import { serviceabilities, serviceability, type ServiceabilityDeps, withAccountStates, withRoutedStates } from "./serviceability.js";

// The one "can this account serve a turn?" answer, fed from every store that holds a fact about it. The ranking cases
// were accountWithHeadroom's, the unnamed pick this replaced; they hold for the rule every picker now shares.

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: "five_hour", utilization: 42, gates: "all", ...over });
const reading = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 2_000 });
const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 0, ...extra });

const deps = (params: {
    readonly accounts?: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly seats?: Record<string, SeatRefusal>;
    readonly refusals?: Record<string, ProviderRefusal>;
    readonly routed?: Partial<TranslatorAccounts>;
}): ServiceabilityDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...(params.accounts ?? [])] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => params.seats ?? {} }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { read: async () => params.refusals ?? {} }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
        accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [], ...params.routed }),
    }),
});

const pick = async (services: ServiceabilityDeps, model?: string): Promise<string | undefined> =>
    preferredAccount(await serviceabilities(services, "claude", model === undefined ? undefined : { id: model }))?.id;

test("ranks accounts on the pools the turn's model spends: a spent Opus slice does not bench an account for Haiku", async () => {
    const services = deps({
        accounts: [account("steady"), account("opus-spent")],
        usage: {
            "opus-spent": reading(window({ kind: "seven_day", utilization: 10 }), window({ kind: "model:Opus", utilization: 100, gates: { models: ["Opus"] } })),
            steady: reading(window({ kind: "seven_day", utilization: 60 })),
        },
    });
    expect(await pick(services, "claude-haiku-4-5")).toBe("opus-spent");
    expect(await pick(services, "claude-opus-4-6")).toBe("steady");
    // With no model named the question is whether SOME turn can run: the full Opus slice leaves the others its room.
    expect(await pick(services)).toBe("opus-spent");
});

test("prefers the most room, read at an account's WORST pool, not its kindest", async () => {
    const services = deps({
        accounts: [account("busy"), account("free"), account("weekly-spent")],
        usage: { busy: reading(window({ utilization: 92 })), free: reading(window({ utilization: 18 })), "weekly-spent": reading(window({ utilization: 4 }), window({ kind: "seven_day", utilization: 100 })) },
    });
    expect(await pick(services)).toBe("free");
});

test("ranks a never-measured account below a proven one, and a spent one below that, keeping the caller's order between equals", async () => {
    const usage = { proven: reading(window({ utilization: 70 })), capped: reading(window({ utilization: 100 })), twin: reading(window({ utilization: 70 })) };
    expect(await pick(deps({ accounts: [account("unmeasured"), account("proven"), account("capped")], usage }))).toBe("proven");
    expect(await pick(deps({ accounts: [account("capped"), account("unmeasured")], usage }))).toBe("unmeasured");
    expect(await pick(deps({ accounts: [account("proven"), account("twin")], usage }))).toBe("proven");
    expect(await pick(deps({ accounts: [account("twin"), account("proven")], usage }))).toBe("twin");
});

test("a revoked sign-in, a lost seat and a standing entitlement refusal each take an account out of the pick, however idle its meter", async () => {
    const usage = { revoked: reading(window({ utilization: 0 })), seatless: reading(window({ utilization: 1 })), refused: reading(window({ utilization: 2 })), working: reading(window({ utilization: 88 })) };
    const services = deps({
        accounts: [account("revoked", { needsReauth: true }), account("seatless"), account("refused"), account("working")],
        usage,
        seats: { seatless: { at: 1, reason: "Your organization has disabled Claude Code." } },
        refusals: { claude: { at: 1, kind: "entitlement", message: "Not entitled.", account: "refused" } },
    });
    expect(await pick(services)).toBe("working");
    expect(await serviceability(services, "claude", "revoked")).toEqual({ kind: "blocked", fix: "reconnect", reason: "sign-in expired" });
    expect(await serviceability(services, "claude", "seatless")).toEqual({ kind: "blocked", fix: "admin", reason: "Your organization has disabled Claude Code." });
    expect(await serviceability(services, "claude", "refused")).toEqual({ kind: "blocked", fix: "admin", reason: "Not entitled." });
    expect(await serviceability(services, "claude", "missing")).toEqual({ kind: "unknown" });
});

test("a standing limit refusal reads its account as spent, until a reading with room lands after it", async () => {
    const accounts = [account("refused"), account("other")];
    const refusals = { claude: { at: 1_000, kind: "limit" as const, message: "Limit reached.", account: "refused" } };
    const stale = { refused: { ...reading(window({ utilization: 10 })), measuredAt: 500 }, other: reading(window({ utilization: 90 })) };
    expect(await pick(deps({ accounts, usage: stale, refusals }))).toBe("other");
    const since = { ...stale, refused: reading(window({ utilization: 10 })) };
    expect(await pick(deps({ accounts, usage: since, refusals }))).toBe("refused");
});

test("a routed provider is judged from the translator's credentials, its bench included", async () => {
    const services = deps({
        routed: {
            gemini: [
                { name: "benched", label: "b", cooling: { until: Math.floor(Date.now() / 1000) + 600, reason: "quota" } },
                { name: "projectless", label: "p", cooling: { reason: "no Antigravity project" } },
                { name: "fine", label: "f", usage: reading(window({ utilization: 30 })) },
            ],
        },
    });
    expect((await serviceabilities(services, "gemini")).map((entry) => [entry.id, entry.state.kind])).toEqual([
        ["benched", "blocked"],
        ["projectless", "blocked"],
        ["fine", "ready"],
    ]);
    expect(await serviceability(services, "gemini", "projectless")).toEqual({ kind: "blocked", fix: "reconnect", reason: "no Antigravity project" });
});

test("the lists publish the same verdict on the rows they already assembled", async () => {
    const services = deps({ refusals: { codex: { at: 1_000, kind: "limit", message: "Limit reached." } } });
    const [row] = await withAccountStates(services, "claude", [account("seatless", { seatRefusal: "No seat.", usage: reading(window({ utilization: 0 })) })]);
    expect(row?.state).toEqual({ kind: "blocked", fix: "admin", reason: "No seat." });
    // A routed refusal names no credential, so it covers them all until one reads with room after it.
    const routed = await withRoutedStates(services, { codex: [{ name: "a", label: "a", usage: { ...reading(window({ utilization: 20 })), measuredAt: 500 } }], grok: [], kimi: [], gemini: [] });
    expect(routed.codex[0]?.state).toEqual({ kind: "spent" });
});
