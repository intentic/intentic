import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import type { Member } from "../../../auth/auth.js";
import { claudeReading } from "../../providers/claude/claude-usage.testing.js";
import { ACCOUNTS_ALL, type AccountReach, accountReachOfPeople } from "../../../secrets/credential-reach.js";
import type { ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { opt } from "../../../opt.js";
import { routeWithinReach, type ReachTurn } from "./account-reach.js";

// Which account a turn runs on once the people its conversation works for have their say: a named account outside
// their AI accounts is refused, a remembered one is moved off, a pick is pinned inside them. Planning's side (the move
// recorded, the refusal coded) is turn-decision's; the roster's is members.routes'.

const reading = (utilization: number): AccountUsage => claudeReading({ five_hour: { utilization } });

const deps = (params: {
    readonly claude?: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly doors?: Record<string, readonly OauthAccount[]>;
}): ServiceabilityDeps => ({
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...(params.claude ?? [])] }),
    claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
    accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
    providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}) }),
    providerAccounts: async (provider) => [...(params.doors?.[provider] ?? [])],
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) }),
});

const account = (id: string, label = id): OauthAccount => ({ id, label, connectedAt: 0 });
const THREE = [account("home", "Home"), account("work", "Work"), account("team", "Team")];
const ROOMY = { home: reading(10), work: reading(40), team: reading(20) };
const services = deps({ claude: THREE, usage: ROOMY });

const OWNER = "owner@example.com";
const bob = (aiAccounts?: readonly string[]): Member => ({ email: "bob@example.com", role: "collaborator", ...opt("aiAccounts", aiAccounts) });
const reachOf = (rows: readonly Member[], people: readonly string[] = ["bob@example.com"]): AccountReach => accountReachOfPeople(people, rows, OWNER);

const turn = (over: Partial<ReachTurn> = {}): ReachTurn => ({ provider: "claude", named: undefined, remembered: undefined, model: undefined, free: false, ...over });
const KEEP = { kind: "keep" } as const;

test("nobody limited, or a row that never named AI accounts, leaves every turn where it was routed", async () => {
    expect(reachOf([bob()])).toEqual(ACCOUNTS_ALL);
    expect(reachOf([bob(["claude:work"])], [OWNER])).toEqual(ACCOUNTS_ALL);
    expect(await routeWithinReach(services, ACCOUNTS_ALL, turn({ named: "home" }), KEEP)).toEqual(KEEP);
});

test("a named account outside the reach is refused, naming the ones that are inside it", async () => {
    const route = await routeWithinReach(services, reachOf([bob(["claude:work"])]), turn({ named: "home" }), KEEP);
    expect(route).toMatchObject({ kind: "refused", account: "home" });
    expect(route.kind === "refused" ? route.message : "").toContain(`"Work"`);
    expect(route.kind === "refused" ? route.message : "").toContain(`"Home"`);
});

test("a named account inside the reach runs there", async () => {
    expect(await routeWithinReach(services, reachOf([bob(["claude:home"])]), turn({ named: "home" }), KEEP)).toEqual(KEEP);
});

test("a remembered account outside the reach moves the conversation onto the pick among the allowed ones", async () => {
    const route = await routeWithinReach(services, reachOf([bob(["claude:work", "claude:team"])]), turn({ remembered: "home" }), KEEP);
    // Team has more room than Work, so the provider's own rule picks it.
    expect(route).toMatchObject({ kind: "move", from: "home", to: "team", reach: true });
});

test("a turn left to the pick is pinned inside the reach, and left alone when every account is inside it", async () => {
    expect(await routeWithinReach(services, reachOf([bob(["claude:work"])]), turn(), KEEP)).toEqual({ kind: "pin", to: "work" });
    expect(await routeWithinReach(services, reachOf([bob(["claude"])]), turn(), KEEP)).toEqual(KEEP);
});

test("a provider's own key allows every account of it, including one connected later", async () => {
    expect(await routeWithinReach(services, reachOf([bob(["claude"])]), turn({ named: "team" }), KEEP)).toEqual(KEEP);
});

test("no account of the provider inside the reach refuses the turn", async () => {
    const route = await routeWithinReach(services, reachOf([bob(["codex:mine"])]), turn({ remembered: "home" }), KEEP);
    expect(route).toMatchObject({ kind: "refused" });
});

test("a provider with no accounts of its own is judged by its own key, and a local model is never held back", async () => {
    const endpoint = turn({ provider: "endpoint/my-endpoint" });
    expect(await routeWithinReach(services, reachOf([bob(["endpoint/my-endpoint"])]), endpoint, KEEP)).toEqual(KEEP);
    expect(await routeWithinReach(services, reachOf([bob(["claude:work"])]), endpoint, KEEP)).toMatchObject({ kind: "refused" });
    expect(await routeWithinReach(services, reachOf([bob([])]), turn({ provider: "endpoint/llama", free: true }), KEEP)).toEqual(KEEP);
});

test("a conversation runs only where every person in it may: a provider key and one account of it narrow to that account", async () => {
    const rows = [bob(["claude"]), { email: "carol@example.com", role: "collaborator", aiAccounts: ["claude:work"] } satisfies Member];
    const reach = reachOf(rows, ["bob@example.com", "carol@example.com"]);
    expect(await routeWithinReach(services, reach, turn(), KEEP)).toEqual({ kind: "pin", to: "work" });
    expect(await routeWithinReach(services, reach, turn({ named: "home" }), KEEP)).toMatchObject({ kind: "refused" });
});

test("a blocked-account move onto an account outside the reach is re-aimed from where the conversation was", async () => {
    const blocked = { kind: "move", from: "home", to: "work", reason: "seat off" } as const;
    expect(await routeWithinReach(services, reachOf([bob(["claude:team"])]), turn({ remembered: "home" }), blocked)).toMatchObject({
        kind: "move",
        from: "home",
        to: "team",
    });
    expect(await routeWithinReach(services, reachOf([bob(["claude:work"])]), turn({ remembered: "home" }), blocked)).toEqual(blocked);
});

test("somebody the roster no longer names, or a roster that cannot be read, runs on nothing", async () => {
    expect(await routeWithinReach(services, reachOf([], ["gone@example.com"]), turn(), KEEP)).toMatchObject({ kind: "refused" });
    const unreadable: AccountReach = { kind: "some", lists: [], who: ["bob@example.com"], unreadable: "EACCES" };
    expect(await routeWithinReach(services, unreadable, turn({ named: "home" }), KEEP)).toMatchObject({ kind: "refused" });
});
