import type { AccountUsage, ProviderRefusal, TranslatorAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import { reopenedBy, sendableAt } from "../../../../conversations/actor/limit-booking.js";
import { createFleet } from "../../../../conversations/registry/agents-registry.js";
import { fleetStoreOver } from "../../../../conversations/registry/agents-registry.testing.js";
import { noPresences } from "../../../../conversations/land/tests/landed-presence.testing.js";
import type { LandStandings } from "../../../../conversations/land/standing.js";
import { openConversationsDb } from "../../../../store/conversations-db.js";
import type { Services } from "../../../../composition.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { createTurnResumeScheduler } from "../turn-resume.js";
import { clearPaces, type RetimePaces } from "./held-standing.js";

/* 2026-11-08: a conversation refused on Google's Gemini pool was held for the instant the refusal named, "Resets in
   152h", and kept waiting for it after an account that could serve Gemini was back, while the picker already showed the
   model servable. A timed hold now goes once the provider's accounts can serve its model, and not before: not while
   every account is still spent, and never over a person's pick of an account. */

const NOW = 1_800_000_000_000;
const REFUSED_AT = NOW - 120_000;
// The instant the refusal named: six days out.
const FAR = NOW / 1000 + 152 * 3_600;
const MODEL = "gemini-3-flash";
const PROFILE = { agent: "gemini", harness: "native" } as const;
const PROMPT = "Port the parser";

const geminiPool = (utilization: number, measuredAt: number): AccountUsage => ({
    windows: [{ kind: "google:models:gemini", label: "Gemini models", utilization, gates: { models: ["gemini"] }, resetsAt: FAR }],
    measuredAt,
});
// Read before the refusal, so the refusal stands over it; and read since, with room in the Gemini pool, which answers it.
const SPENT: TranslatorAccount = { name: "old.json", label: "old@example.com", usage: geminiPool(30, REFUSED_AT - 60_000) };
const BACK: TranslatorAccount = { name: "new.json", label: "new@example.com", usage: geminiPool(20, NOW - 10_000) };
const STILL_SPENT: TranslatorAccount = { name: "new.json", label: "new@example.com", usage: geminiPool(100, NOW - 10_000) };
// Google's refusal names no account: the translator chose one, and nothing says which.
const REFUSAL: ProviderRefusal = { at: REFUSED_AT, kind: "limit", message: "Resets in 152h", model: MODEL, resetsAt: FAR };

const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });

const fleet = async (accounts: readonly TranslatorAccount[]) => {
    const settings = { get: async () => SandboxSettingsSchema.parse({ limitPolicy: "resend" }), onSet: () => () => undefined };
    const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences(), { settings });
    await agents.init();
    const on = { accounts };
    const started: TurnInput[] = [];
    const services = unstubbed<Services>("services", {
        agents,
        conversations,
        logger: pino({ level: "silent" }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
        resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [...on.accounts] }),
        }),
        providerAccounts: async () => [],
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ gemini: [REFUSAL] }) }),
        turns: unstubbed<Services["turns"]>("turns", {
            drain: async () => {},
            start: async (turn) => {
                started.push(turn);
                return { id: `run-${started.length}`, async *frames() {} };
            },
        }),
    });
    return { agents, conversations, services, started, on };
};

// Refused on the Gemini pool, held for the instant the refusal named; `account` where the conversation names one.
const refused = async (at: Awaited<ReturnType<typeof fleet>>, account?: string) => {
    const profile = account === undefined ? PROFILE : { ...PROFILE, account };
    await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: PROMPT, profile }, REFUSED_AT);
    const frame = {
        kind: "error" as const,
        code: "rate_limit" as const,
        message: "Resets in 152h",
        held: { ran: true },
        resetsAt: FAR,
        autoResume: "scheduled" as const,
    };
    at.conversations.send("c1", { kind: "frame", frame }, REFUSED_AT);
    const input = { conversationId: "c1", prompt: PROMPT, ...profile, model: MODEL };
    at.conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", ran: true, reopensAt: FAR } }, REFUSED_AT);
    await at.conversations.send("c1", { kind: "settle" }, REFUSED_AT + 10_000).settled;
};

describe("a timed spent-allowance hold", () => {
    it("goes now once an account that can serve its model reads ready, rather than at the instant it was refused with", async () => {
        const at = await fleet([SPENT, BACK]);
        await refused(at);

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reopensAt: reopenedBy(NOW), fired: false });
        expect(at.agents.get("c1")?.next).toMatchObject({ kind: "rerun", at: sendableAt(reopenedBy(NOW)) });

        await createTurnResumeScheduler(at.services).tick(NOW + 1_000);
        expect(at.started.map((turn) => turn.model)).toEqual([MODEL]);
    });

    it("keeps its instant while every account is still spent", async () => {
        const at = await fleet([SPENT, STILL_SPENT]);
        await refused(at);

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reopensAt: FAR, fired: false });
        expect(at.agents.get("c1")?.next).toMatchObject({ kind: "rerun", at: sendableAt(FAR) });
        expect(at.started).toEqual([]);
    });

    it("leaves a hold a person pointed at an account to that account's reopen", async () => {
        const at = await fleet([SPENT, BACK]);
        await refused(at);
        expect(at.conversations.send("c1", { kind: "held-repointed", account: SPENT.name, carry: true, reopensAt: FAR }).reply).toBe(true);

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reopensAt: FAR, onto: { account: SPENT.name }, fired: false });
        expect(at.started).toEqual([]);
    });

    // The pass sends it to the account its conversation names, and would only hold it behind that account's wall again.
    it("keeps its instant while the account it would go on is still spent, whatever the others can serve", async () => {
        const at = await fleet([SPENT, BACK]);
        await refused(at, SPENT.name);

        await createTurnResumeScheduler(at.services).tick(NOW);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ reopensAt: FAR, fired: false });
        expect(at.started).toEqual([]);
    });

    // Paced as the untimed hold is, once a minute, unless news of its own provider (a reading, an account back) clears it.
    it("asks again within its minute only when its own provider has news", async () => {
        const at = await fleet([SPENT, STILL_SPENT]);
        await refused(at);
        const scheduler = createTurnResumeScheduler(at.services);
        await scheduler.tick(NOW);

        at.on.accounts = [SPENT, BACK];
        await scheduler.tick(NOW + 5_000);
        expect(at.conversations.state("c1")?.resume.held?.reopensAt).toBe(FAR);
        scheduler.retime("codex");
        await scheduler.tick(NOW + 6_000);
        expect(at.conversations.state("c1")?.resume.held?.reopensAt).toBe(FAR);
        scheduler.retime("gemini");
        await scheduler.tick(NOW + 7_000);
        expect(at.conversations.state("c1")?.resume.held?.reopensAt).toBe(reopenedBy(NOW + 7_000));
    });

    it("takes an early instant only when it is sooner than its own", async () => {
        const at = await fleet([SPENT]);
        await refused(at);
        expect(at.conversations.send("c1", { kind: "held-retimed", reopensAt: FAR + 60 }).reply).toBe(false);
        expect(at.conversations.send("c1", { kind: "held-retimed", reopensAt: FAR + 60, early: true }).reply).toBe(false);
        expect(at.conversations.send("c1", { kind: "held-retimed", reopensAt: FAR - 60 }).reply).toBe(false);
        expect(at.conversations.send("c1", { kind: "held-retimed", reopensAt: FAR - 60, early: true }).reply).toBe(true);
    });
});

describe("clearPaces", () => {
    it("clears one provider's holds, or every hold where none is named", () => {
        const paces: RetimePaces = new Map([
            ["gemini\u0000c1", 1],
            ["gemini\u0000c2", 1],
            ["codex\u0000c3", 1],
        ]);
        clearPaces(paces, "gemini");
        expect([...paces.keys()]).toEqual(["codex\u0000c3"]);
        clearPaces(paces);
        expect(paces.size).toBe(0);
    });
});
