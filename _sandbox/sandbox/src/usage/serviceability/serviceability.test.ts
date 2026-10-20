import type { AccountUsage, ProviderRefusal, TranslatorAccounts, UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import type { SeatRefusal } from "../../agent/providers/claude/claude-seats.js";
import { allowanceWall, fleetCapacityOf, serviceabilities, serviceability, type ServiceabilityDeps } from "./serviceability.js";

// The one "can this account serve a turn?" answer, fed from every store that holds a fact about it. The ranking cases
// were accountWithHeadroom's, the unnamed pick this replaced; they hold for the rule every picker now shares.

const window = (over: Partial<UsageWindow> = {}): UsageWindow => ({ kind: "five_hour", utilization: 42, gates: "all", ...over });
const reading = (...windows: UsageWindow[]): AccountUsage => ({ windows, measuredAt: 2_000 });
const account = (id: string, extra: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 0, ...extra });

const deps = (params: {
    readonly accounts?: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly seats?: Record<string, SeatRefusal>;
    // Every refusal on file, by provider.
    readonly refusals?: Record<string, readonly ProviderRefusal[]>;
    readonly routed?: Partial<TranslatorAccounts>;
    // The accounts a provider's own door lists (Cursor, Devin, the minted providers).
    readonly doors?: Record<string, readonly OauthAccount[]>;
}): ServiceabilityDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...(params.accounts ?? [])] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => params.seats ?? {} }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => params.refusals ?? {} }),
    providerAccounts: async (provider) => [...(params.doors?.[provider] ?? [])],
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
        refusals: { claude: [{ at: 1, kind: "entitlement", message: "Not entitled.", account: "refused" }] },
    });
    expect(await pick(services)).toBe("working");
    expect(await serviceability(services, "claude", "revoked")).toEqual({ kind: "blocked", fix: "reconnect", reason: "sign-in expired" });
    expect(await serviceability(services, "claude", "seatless")).toEqual({ kind: "blocked", fix: "admin", reason: "Your organization has disabled Claude Code." });
    expect(await serviceability(services, "claude", "refused")).toEqual({ kind: "blocked", fix: "admin", reason: "Not entitled." });
    expect(await serviceability(services, "claude", "missing")).toEqual({ kind: "unknown" });
});

test("a standing limit refusal reads its account as spent, until a reading with room lands after it", async () => {
    const accounts = [account("refused"), account("other")];
    const refusals = { claude: [{ at: 1_000, kind: "limit" as const, message: "Limit reached.", account: "refused" }] };
    const stale = { refused: { ...reading(window({ utilization: 10 })), measuredAt: 500 }, other: reading(window({ utilization: 90 })) };
    expect(await pick(deps({ accounts, usage: stale, refusals }))).toBe("other");
    const since = { ...stale, refused: reading(window({ utilization: 10 })) };
    expect(await pick(deps({ accounts, usage: since, refusals }))).toBe("refused");
});

// 2026-10-11 (mellow-gale): the provider's last refusal moved on to whichever account said no next, and an account read at
// 100 by a provider that rounds, only proven spent by its own refusal, read as ready again. Every refusal is on file.
test("an account's own limit refusal holds it spent after another account is refused", async () => {
    const reopensAt = Math.floor(Date.now() / 1000) + 86_400;
    const atTheLine = { ...reading(window({ kind: "seven_day", utilization: 100, rounded: true, resetsAt: reopensAt })), measuredAt: Date.now() };
    const accounts = [account("spent", { usage: atTheLine }), account("roomy", { usage: reading(window({ utilization: 30 })) })];
    const own = { at: Date.now() - 60_000, kind: "limit" as const, message: "Claude usage limit reached.", account: "spent", model: "claude-opus-5-5", resetsAt: reopensAt };
    const services = deps({
        accounts,
        usage: { spent: atTheLine, roomy: reading(window({ utilization: 30 })) },
        // The provider's newest refusal names another account: a revoked token, which says nothing about this pool.
        refusals: { claude: [{ at: Date.now(), kind: "auth", message: "OAuth token revoked.", account: "elsewhere" }, own] },
    });

    expect(await serviceability(services, "claude", "spent")).toEqual({ kind: "spent", reopensAt });
    // The wall a held turn is booked against is that very verdict (2026-10-19, fleet-quill: a pick between two spent
    // accounts re-booked a held turn for "now", reading the polled reading alone).
    expect(await allowanceWall(services, "claude", "spent")).toEqual({ reopensAt });
    expect(await allowanceWall(services, "claude", "roomy")).toBeUndefined();
    expect(await pick(services)).toBe("roomy");
    // Without its own refusal on file, the same reading is at the line: no room, but not proven spent.
    expect(await serviceability(deps({ accounts, usage: { spent: atTheLine } }), "claude", "spent")).toEqual({ kind: "ready", room: 0 });
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

// 2026-10-13 (solid-meadow, sunny-fern): the spawn listing read Claude's store and the translator only, so a Cursor or
// Devin model every account had refused stayed "not metered", and Sol children went onto a Codex the picker greyed.
// Every provider's accounts reach the one rule the same way, refusals on file included.
test("a provider that publishes no reading is judged from its door's accounts and the refusals on file", async () => {
    const refused = (id: string) => ({ at: Date.now() - 60_000, kind: "limit" as const, message: "You're out of usage.", account: id, model: "composer-2.5" });
    const services = deps({ doors: { cursor: [account("x"), account("y")] }, refusals: { cursor: [refused("x"), refused("y")] } });
    expect((await fleetCapacityOf(services, "cursor", { id: "composer-2.5" })).kind).toBe("spent");
    expect((await fleetCapacityOf(services, "cursor", { id: "gpt-6" })).kind).toBe("serving");
    // One account still clear of it keeps the model servable, and the placement goes there.
    const one = deps({ doors: { cursor: [account("x"), account("y")] }, refusals: { cursor: [refused("x")] } });
    expect(await fleetCapacityOf(one, "cursor", { id: "composer-2.5" })).toEqual({ kind: "serving", serving: 1, accounts: 2, roomMeasuredAt: undefined });
    expect(preferredAccount(await serviceabilities(one, "cursor", { id: "composer-2.5" }))?.id).toBe("y");
});

test("a routed refusal naming no credential covers them all until one reads with room after it", async () => {
    const services = deps({
        refusals: { codex: [{ at: 1_000, kind: "limit", message: "Limit reached.", model: "gpt-6.1-sol" }] },
        routed: { codex: [{ name: "a", label: "a", usage: { ...reading(window({ utilization: 20 })), measuredAt: 500 } }] },
    });
    expect(await fleetCapacityOf(services, "codex", { id: "gpt-6.1-sol" })).toMatchObject({ kind: "spent", accounts: 1 });
    const since = deps({
        refusals: { codex: [{ at: 1_000, kind: "limit", message: "Limit reached.", model: "gpt-6.1-sol" }] },
        routed: { codex: [{ name: "a", label: "a", usage: reading(window({ utilization: 20 })) }] },
    });
    expect((await fleetCapacityOf(since, "codex", { id: "gpt-6.1-sol" })).kind).toBe("serving");
});

test("a caller that passes the logger gets a line when an account's verdict changes", async () => {
    const { lines, logger } = recordingLogger();
    const accounts = [account("weekly", { label: "rkrohmorath" })];
    await serviceabilities({ ...deps({ accounts, usage: { weekly: reading(window({ kind: "seven_day", utilization: 100 })) } }), logger }, "claude");
    expect(lines).toMatchObject([{ message: "accounts: claude account rkrohmorath unseen → spent", account: "weekly", window: "seven_day", utilization: 100 }]);
});
