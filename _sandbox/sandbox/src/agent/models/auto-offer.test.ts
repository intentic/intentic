import type { AccountUsage, ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Model, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { currentWindows } from "@intentic/sandbox-contract/models/plan-pools";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { claudeLimitRefusal } from "../providers/claude/claude-usage.testing.js";

/* WHAT THE AUTO JUDGE MAY CHOOSE FROM, at the seam it reads: readiness, accounts and catalogs are all handed in, so a
   test can state an allowance and see which models survive it. The accounts reach it as they reach every gate
   (serviceability.ts accountFactsOf), Claude's from its store and readings. */

const ready = jest.fn<() => Record<string, boolean>>();
const accountLists = jest.fn<() => Record<string, readonly OauthAccount[]>>();

jest.mock("../providers/provider-registry.js", () => ({
    providerReadiness: async () => ready(),
}));

const { autoOffer } = await import("./auto-offer.js");

const NOW = 1_700_000_000_000;
const IN_TWO_HOURS = Math.floor(NOW / 1000) + 2 * 3600;
const AN_HOUR_AGO = Math.floor(NOW / 1000) - 3600;

const OPUS: Model = { id: "claude-opus-5", label: "Opus 5", efforts: ["low", "high"] };
const HAIKU: Model = { id: "claude-haiku-4-5", label: "Haiku 4.5" };

// One account's reading, in the one shape every provider files: what each pool has spent, and when it was measured.
const usage = (windows: AccountUsage["windows"]): AccountUsage => ({ windows, measuredAt: NOW - 60_000 });
// A Claude account's five-hour pool, rounded as the Claude reader files every pool: at 100 it reads at the line, and
// only a refusal on file proves the account spent (claude-usage.testing.ts).
const session = (utilization: number, resetsAt?: number): AccountUsage["windows"][number] => ({
    kind: "session",
    label: "5 hours",
    utilization,
    gates: "all",
    rounded: true,
    ...(resetsAt === undefined ? {} : { resetsAt }),
});

const account = (id: string, snapshot?: AccountUsage): OauthAccount => ({
    id,
    label: id,
    connectedAt: NOW,
    ...(snapshot === undefined ? {} : { usage: snapshot }),
});

const warn = jest.fn();
const catalogs = jest.fn<(provider: NativeProvider) => Promise<{ models: Model[]; default: string }>>();

// The refusals on file a test sets: Claude's own word that an account is spent.
let refused: readonly ProviderRefusal[] = [];
const claudeAccounts = (): readonly OauthAccount[] => accountLists()["claude"] ?? [];
const services = (): Services =>
    unstubbed<Services>("services", {
        logger: unstubbed<Services["logger"]>("logger", { warn, info: () => undefined } as Partial<Services["logger"]>),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: refused }) }),
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => claudeAccounts().map(({ usage: _usage, ...row }) => row) }),
        claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
        // As the store reads its file: a window past its reset kept as lapsed, at the floor.
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", {
            read: async () =>
                Object.fromEntries(
                    claudeAccounts().flatMap((row) => (row.usage === undefined ? [] : [[row.id, { ...row.usage, windows: currentWindows(row.usage, NOW) }]])),
                ),
        }),
        providerCatalogs: new Proxy({} as Services["providerCatalogs"], {
            get: (_target, provider: string) => ({ models: () => catalogs(provider as NativeProvider) }),
        }),
    });

beforeEach(() => {
    refused = [];
    warn.mockReset();
    catalogs.mockReset();
    ready.mockReturnValue({ claude: true });
    accountLists.mockReturnValue({ claude: [] });
    catalogs.mockResolvedValue({ models: [OPUS, HAIKU], default: OPUS.id });
});

test("a provider that cannot run a turn is never offered, and its catalog is never read", async () => {
    ready.mockReturnValue({ claude: false });
    const offer = await autoOffer(services(), NOW);
    expect(offer.models).toEqual([]);
    expect(catalogs).not.toHaveBeenCalled();
});

test("with no account on file the models still stand: an unnamed account is a real state, not a refusal", async () => {
    const offer = await autoOffer(services(), NOW);
    expect(offer.models.map((model) => model.model)).toEqual([OPUS.id, HAIKU.id]);
    expect(offer.accounts["claude"]).toEqual([]);
});

test("a model every connected account is at cap for is dropped before the judge sees it", async () => {
    accountLists.mockReturnValue({ claude: [account("work", usage([session(100)])), account("spare", usage([session(100)]))] });
    refused = [claudeLimitRefusal({ account: "work", at: NOW - 60_000 }), claudeLimitRefusal({ account: "spare", at: NOW - 60_000 })];
    const offer = await autoOffer(services(), NOW);
    // Nothing runnable, so the provider goes whole: offering its accounts would invite a pick with nothing to run.
    expect(offer.models).toEqual([]);
    expect(offer.accounts["claude"]).toBeUndefined();
});

test("an unmeasured account keeps a model askable: silence is not evidence of a spent pool", async () => {
    accountLists.mockReturnValue({ claude: [account("work", usage([session(100)])), account("never-read")] });
    refused = [claudeLimitRefusal({ account: "work", at: NOW - 60_000 })];
    const offer = await autoOffer(services(), NOW);
    expect(offer.models.map((model) => model.model)).toEqual([OPUS.id, HAIKU.id]);
});

test("an account's windows report what is LEFT, named by the pool's own length", async () => {
    accountLists.mockReturnValue({ claude: [account("work", usage([session(38, IN_TWO_HOURS)]))] });
    const offer = await autoOffer(services(), NOW);
    expect(offer.accounts["claude"]).toEqual([
        { id: "work", label: "work", windows: [{ short: "5h", label: "5 hours", left: 62, resetsAt: IN_TWO_HOURS }] },
    ]);
});

test("a window already past its reset is gone, not shown as spent", async () => {
    // The pool it described no longer exists; carrying it forward would bench a model that is in fact free to run. The
    // store keeps it as lapsed, at the floor, which the judge is not shown as a reading.
    accountLists.mockReturnValue({ claude: [account("work", usage([session(100, AN_HOUR_AGO)]))] });
    const offer = await autoOffer(services(), NOW);
    expect(offer.accounts["claude"]).toEqual([{ id: "work", label: "work", windows: [] }]);
    expect(offer.models.map((model) => model.model)).toEqual([OPUS.id, HAIKU.id]);
});

test("the effort ladder rides with the model, and a model that publishes none says so", async () => {
    const offer = await autoOffer(services(), NOW);
    expect(offer.models[0]?.efforts).toEqual(["low", "high"]);
    expect(offer.models[1]?.efforts).toEqual([]);
});

test("a catalog that will not load leaves its provider out rather than failing the whole offer", async () => {
    catalogs.mockRejectedValue(new Error("upstream down"));
    const offer = await autoOffer(services(), NOW);
    expect(offer.models).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
        { err: expect.any(Error), provider: "claude" },
        "auto model: catalog unreadable, leaving this provider out of the offer",
    );
});
