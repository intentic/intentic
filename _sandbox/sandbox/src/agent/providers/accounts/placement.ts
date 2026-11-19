import { AgentHarnessSchema, type AgentHarness, type AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { accountServesLoop, loopDoor, loopOf, reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import { moveDestination } from "@intentic/sandbox-contract/models/account-moves";
import { bestWithRoom, type ModelRef, preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { Services } from "../../../composition.js";
import type { PlacementNarrowing } from "../../../usage/serviceability/capacity-feed.js";
import { type JudgedAccount, judgedAccounts, serviceabilities, type ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { pickAccount, type PlanAccount, type PlannerDeps } from "../../run/spend/budget-planner.js";

/* WHICH ACCOUNT A TURN RUNS ON, decided here and nowhere else, for every question that asks it. Whether an account CAN
   serve is serviceability.ts's (the verdicts); which of the ones that can a turn goes on is this module's, over those
   verdicts, in four variants, because the four questions genuinely differ:
   - a turn naming no account (unnamedPlacement, unnamedAmong): the account the sandbox's rule prefers (plan-pools.ts
     preferredAccount: room, the allowance that renews first unless nearly out, then unmeasured, then spent), where the
     fan-out planner carries the provider (LOAD_AWARE_PLACEMENT) the one it places the turn on once what already runs on
     each account is counted. Every runtime that holds its accounts' credentials asks it (Claude, Cursor, Devin, the
     minted keys, a vendor CLI's sign-ins), as do the reach's pin (account-reach.ts), the capacity every window draws
     (placementFor) and usage.placement;
   - a move off an account that cannot serve (moveTarget, moveDestinationFor): the limit move (sibling-account.ts), the
     move off a blocked account (blocked-account.ts) and off one the records call spent (account-placement.ts
     offSpentAccount). Only proven room, or where the provider publishes no allowance an account nothing has refused
     (account-moves.ts moveDestination), the planner's pick first where it carries the provider;
   - a cold conversation's re-placement (coldTarget): proven room only, by the same order, which account-placement.ts
     then weighs against staying;
   - a routed request's pin order (pinOrder): the gateway (translator-gateway.ts) asks every account that can serve the
     model best first by the same rule, then probes a spent one or two.

   2026-11-19: before this, each subsystem picked for itself. Nine pickers ran the rule their own way: the minted route,
   Cursor's runtime (on its refusals alone), the gateway, the limit move, the cold and spent moves, the blocked move, the
   reach's pin, and Claude's own pick; the spawn listing, the Auto offer and the planner each ran the verdict rule on raw
   facts. Only Claude's pick and the limit move counted load, so a member held to some accounts was pinned by the
   verdicts alone, a blocked or spent move could land on the account children crowded, and the browser predicted the
   pick from its own rows and was wrong whenever the daemon's differed. Keeping every picker and fixing each in place
   was rejected for the reason conventions.md "One door per concern" gives: the next fix would again reach only some. */

/** What a placement reads: the verdicts, and, where given, what the fan-out planner projects from. */
export type PlaceDeps = ServiceabilityDeps & Partial<PlannerDeps>;

/** What `placementFor` reads beyond a placement: the catalogs a turn naming no model resolves its default from. */
export type PlacementDeps = PlaceDeps & Pick<Services, "providerCatalogs">;

/* THE PROVIDERS WHOSE PLACEMENT COUNTS WHAT ALREADY RUNS ON EACH ACCOUNT, so a turn starting or ending moves it
   (boot-schedulers.ts nudges their capacity). Claude alone, for two reasons that hold for every other provider. The
   planner projects an account's readings (budget-planner.ts planAccounts places only an account the rule calls ready
   with room, which needs a reading), and every other provider whose accounts a turn names publishes none: Cursor, Devin,
   the minted keys and a vendor CLI's sign-ins are judged on their refusals alone. The other metered providers (Codex,
   Gemini, Kimi's subscriptions) are routed: the gateway pins each request on its own, under a session signed for the
   provider alone (translator-gateway-session.ts), and a routed turn carries no account (stream-agent.ts TurnState), so
   there is neither a load to count per account nor a turn that stays where it was placed. */
export const LOAD_AWARE_PLACEMENT: readonly AgentProvider[] = ["claude"];

const modelRef = (model: string | undefined): ModelRef | undefined => (model === undefined || model === "" ? undefined : { id: model });

// Whether the provider's conversations are bound to no account of their own: a routed provider's requests are each
// placed by the gateway (pinOrder), so no move or cold re-placement asks about one.
const routedProvider = (provider: AgentProvider): boolean => KeyedProviderSchema.safeParse(provider).success;

// The planner's pick among `rows`, for a provider it places and with what it projects from given: an account with proven
// room only, with what already runs on each counted (budget-planner.ts pickAccount). Undefined where it cannot say
// (another provider, no model to price, nothing ready with room, a record it could not read), which leaves the verdicts'
// own order to answer.
const planned = async <R extends PlanAccount>(services: PlaceDeps, provider: AgentProvider, model: string | undefined, rows: readonly R[]): Promise<R | undefined> => {
    const { burnRates, runOuts, sandboxSettings } = services;
    if (!LOAD_AWARE_PLACEMENT.includes(provider) || model === undefined || model === "" || rows.length === 0) {
        return undefined;
    }
    if (burnRates === undefined || runOuts === undefined || sandboxSettings === undefined) {
        return undefined;
    }
    const picked = await pickAccount({ burnRates, runOuts, sandboxSettings }, { provider, model, accounts: rows }).catch(
        // allow(silent-catch): the planner is advice on which ready account a turn goes on; the verdicts' order still answers.
        () => undefined,
    );
    return rows.find((row) => row.id === picked);
};

/* ---- a turn naming no account ------------------------------------------------------------------------------- */

/**
 * Where a turn naming no account runs among `rows`, already judged for its model (serviceability.ts judgedAccounts): the
 * planner's pick where it carries the provider, else the rule's preferred account. A single row is not a choice.
 */
export const unnamedAmong = async <R extends JudgedAccount>(services: PlaceDeps, provider: AgentProvider, rows: readonly R[], model: string | undefined): Promise<R | undefined> =>
    rows.length < 2 ? rows[0] : ((await planned(services, provider, model, rows)) ?? preferredAccount(rows));

/**
 * The account a turn naming none runs on, among `accounts` (those its loop can serve, in the provider's own order),
 * judged for `model` where it names one. A single account is not a choice; verdicts that cannot be read keep the first,
 * as before, and say so.
 */
export const unnamedPlacement = async <T extends { readonly id: string }>(
    services: PlaceDeps,
    provider: AgentProvider,
    accounts: readonly T[],
    model: string | undefined,
): Promise<T | undefined> => {
    if (accounts.length < 2) {
        return accounts[0];
    }
    try {
        const rows = (await judgedAccounts(services, provider, modelRef(model))).filter((row) => accounts.some((account) => account.id === row.id));
        const picked = await unnamedAmong(services, provider, rows, model);
        return accounts.find((account) => account.id === picked?.id) ?? accounts[0];
    } catch (error) {
        services.logger?.warn({ err: error, provider }, "placement: the accounts' verdicts could not be read, the turn runs on the first connected");
        return accounts[0];
    }
};

// The model a pick is judged for where a turn names none: the catalog's default for a runtime that resolves it before
// it places the turn (Claude's CLI runs it; Cursor's turn asks for it, cursor-provider.ts planCursorTurn). Asked with no
// model, the rule answers whether SOME turn can run, and an account whose only full pool is the default model's own
// slice would win a pick it then loses. Every other runtime places a turn naming none on that question, as asked.
const pickModelOf = async (services: Pick<Services, "providerCatalogs">, provider: "claude" | "cursor", model: string | undefined): Promise<ModelRef | undefined> => {
    if (model !== undefined && model !== "") {
        return { id: model };
    }
    // allow(silent-catch): an unreadable catalog only leaves the pick asking whether SOME turn can run, never fails the turn.
    const fallback = await services.providerCatalogs[provider].models().then(
        (catalog) => catalog.default,
        () => undefined,
    );
    return fallback === undefined ? undefined : { id: fallback };
};

/** The model an unnamed Claude pick is judged for: the one the turn names, else the catalog's default (pickModelOf). */
export const claudePickModel = (services: Pick<Services, "providerCatalogs">, model: string | undefined): Promise<ModelRef | undefined> =>
    pickModelOf(services, "claude", model);

const turnModelOf = async (services: Pick<Services, "providerCatalogs">, provider: AgentProvider, model: string | undefined): Promise<string | undefined> =>
    provider === "claude" || provider === "cursor" ? (await pickModelOf(services, provider, model))?.id : model;

// The provider whose subscriptions a turn on this loop spends, each request pinned by the gateway, rather than an account
// of the provider's own door; undefined for a door's. Grok on OpenCode runs on its own xAI sign-in. The editor reads the
// same split (access.ts subscriptionProviderOn).
const pinnedPerRequest = (provider: AgentProvider, harness: AgentHarness): KeyedProvider | undefined => {
    const keyed = KeyedProviderSchema.safeParse(provider);
    return keyed.success && loopDoor(provider, harness) === undefined && !(provider === "grok" && loopOf(provider, harness) === "opencode") ? keyed.data : undefined;
};

// The accounts a turn on this loop is placed among, in the provider's own order: Claude's from its store, any other's
// from its own door, those whose sign-in serves the loop (agent-catalog.ts accountServesLoop: Kimi CLI's and Grok Build's
// sign-ins serve their own loop alone). The editor's rows narrow the same way (runServing.ts accountRows).
const accountsOnLoop = async (services: ServiceabilityDeps, provider: AgentProvider, harness: AgentHarness): Promise<readonly { readonly id: string }[]> => {
    if (provider === "claude") {
        return services.claudeStore.list();
    }
    const native = NATIVE_PROVIDERS.find((id) => id === provider);
    return native === undefined ? [] : (await services.providerAccounts(native)).filter((account) => accountServesLoop(provider, harness, account));
};

/**
 * The account a turn naming no account would run on now, for `provider` and `model` (absent: the turn names none): the
 * very pick the turn makes, on the loop `narrow` names (an AgentHarness; absent, or one this daemon does not know, the
 * provider's default) and among the accounts it allows (the asker's reach, account-reach.ts; absent, every one). A routed
 * loop answers the account the gateway would pin its next request to. Undefined where the provider has no account to
 * place on. What every window draws (capacity-feed.ts, with no narrowing) and usage.placement answers.
 */
export const placementFor = async (services: PlacementDeps, provider: AgentProvider, model: string | undefined, narrow: PlacementNarrowing = {}): Promise<string | undefined> => {
    const harness = AgentHarnessSchema.catch("native").parse(narrow.loop ?? "native");
    const allows = narrow.allows ?? (() => true);
    const routed = pinnedPerRequest(provider, harness);
    if (routed !== undefined) {
        // Among the translator's credentials alone: the provider's own door may hold sign-ins of another loop beside them.
        const credentials = new Set((await services.cliProxy.accounts())[routed].map((credential) => credential.name));
        return (await pinOrder(services, provider, model, (account) => credentials.has(account) && allows(account)))[0];
    }
    const accounts = (await accountsOnLoop(services, provider, harness)).filter((account) => allows(account.id));
    return (await unnamedPlacement(services, provider, accounts, await turnModelOf(services, provider, model)))?.id;
};

/* ---- a move off an account that cannot serve ------------------------------------------------------------------ */

/**
 * Where a turn goes off an account that cannot serve it, among `others` (judged for its model, the account it leaves
 * left out): the planner's pick where it carries the provider, else the move rule's (account-moves.ts moveDestination:
 * proven room, else, where the provider publishes no allowance or every account with a reading is refused, an account
 * nothing has refused). Undefined: nowhere to go.
 */
export const moveTarget = async <R extends JudgedAccount>(services: PlaceDeps, provider: AgentProvider, model: string | undefined, others: readonly R[]): Promise<R | undefined> =>
    (await planned(services, provider, model, others)) ?? moveDestination(others, reportsPlanLimits(provider));

/**
 * Where a turn moves off `from` (moveTarget), reading the verdicts itself, among the accounts `allows` admits. A routed
 * provider answers nothing: its gateway already tried every account before a refusal reached the turn.
 */
export const moveDestinationFor = async (
    services: PlaceDeps,
    provider: AgentProvider,
    model: string | undefined,
    narrow: { readonly from: string | undefined; readonly allows?: ((account: string) => boolean) | undefined },
): Promise<string | undefined> => {
    if (routedProvider(provider)) {
        return undefined;
    }
    const allows = narrow.allows ?? (() => true);
    // allow(silent-catch): verdicts that cannot be read move nothing; the turn stays held where it was refused.
    const rows = await judgedAccounts(services, provider, modelRef(model)).catch((): readonly JudgedAccount[] => []);
    return (await moveTarget(services, provider, model, rows.filter((row) => row.id !== narrow.from && allows(row.id))))?.id;
};

/* ---- a cold conversation's re-placement ------------------------------------------------------------------------- */

/**
 * The account a cold conversation would be re-placed on among `others` (judged for its model, its own account left
 * out): proven room only, the planner's pick where it carries the provider, else the best by the rule (plan-pools.ts
 * bestWithRoom). Whether that is worth a move is account-placement.ts's to weigh.
 */
export const coldTarget = async <R extends JudgedAccount>(services: PlaceDeps, provider: AgentProvider, model: string | undefined, others: readonly R[]): Promise<R | undefined> =>
    (await planned(services, provider, model, others)) ?? bestWithRoom(others);

/* ---- a routed request's pin order -------------------------------------------------------------------------------- */

/* A SPENT ACCOUNT IS STILL ASKED, AFTER EVERY ONE WITH ROOM. A refusal the gateway filed names its account, and only an
   answer pinned to that account settles it (translator-gateway.ts settleOn): the turn's own answer names the
   subscription, not the account the request landed on (frame-effects.ts readingAccount), and a refusal that named its
   reset outranks every reading of the account until then (refusal-verdict.ts verdictOn). Left out of the ranking, a
   spent account was never asked again, so once every account read spent each request went unpinned, was answered, and
   settled nothing: a ChatGPT allowance OpenAI reset early read empty in every window while the person's forced Codex
   sends went through, and the composer kept booking them for the old reset (2026-11-13). So after every account with
   room, the spent ones that refused longest ago are asked too, at most SPENT_PROBES of them: one still spent refuses
   again at the cost of a round trip, and the one that answers is settled the moment its answer comes whole. A bench, a
   revoked sign-in or a lost seat is never asked: no window reopening lifts those. */
const SPENT_PROBES = 2;

/**
 * The accounts of a routed provider a request for `model` may be pinned to, in the order they are asked: those the
 * verdict says can serve it (ready, or nothing known against them) best first by the one rule every pick follows, then at
 * most SPENT_PROBES the verdict calls spent, the one refused longest ago first; only those `pinnable` admits (the
 * gateway's: the translator knows them by a prefix).
 */
export const pinOrder = async (
    services: ServiceabilityDeps,
    provider: AgentProvider,
    model: string | undefined,
    pinnable: (account: string) => boolean = () => true,
): Promise<readonly string[]> => {
    const [rows, onFile] = await Promise.all([serviceabilities(services, provider, modelRef(model)), services.providerRefusals.onFile()]);
    const left = rows.filter((row) => (row.state.kind === "ready" || row.state.kind === "unknown") && pinnable(row.id));
    const ranked: string[] = [];
    for (let best = preferredAccount(left); best !== undefined; best = preferredAccount(left)) {
        left.splice(left.indexOf(best), 1);
        ranked.push(best.id);
    }
    // When each account was last refused, so a probe goes round them rather than asking the same one every time.
    const refusedAt = (account: string): number =>
        Math.max(0, ...(onFile[provider] ?? []).flatMap((refusal) => (refusal.account === account ? [refusal.at] : [])));
    const probes = rows
        .filter((row) => row.state.kind === "spent" && pinnable(row.id))
        .toSorted((one, other) => refusedAt(one.id) - refusedAt(other.id))
        .map((row) => row.id);
    return [...ranked, ...probes.slice(0, SPENT_PROBES)];
};
