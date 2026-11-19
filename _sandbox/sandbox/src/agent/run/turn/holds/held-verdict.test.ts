import type { AccountUsage, ProviderRefusal, TranslatorAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import { sendableAt } from "../../../../conversations/actor/limit-booking.js";
import { createFleet } from "../../../../conversations/registry/agents-registry.js";
import { fleetStoreOver } from "../../../../conversations/registry/agents-registry.testing.js";
import { noPresences } from "../../../../conversations/land/tests/landed-presence.testing.js";
import type { LandStandings } from "../../../../conversations/land/standing.js";
import { openConversationsDb } from "../../../../store/conversations-db.js";
import type { Services } from "../../../../composition.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { ACCOUNTS_ALL } from "../../../../secrets/credential-reach.js";
import { claudeLimitRefusal, claudeReading } from "../../../providers/claude/claude-usage.testing.js";
import { createTurnResumeScheduler } from "../turn-resume.js";
import type { HeldOf } from "./held-turn.js";

/* WHEN AND WHERE A SPENT ALLOWANCE'S HELD TURN GOES is read against the records at every pass (held-verdict.ts), never
   kept as an instant and reconciled after the fact. 2026-11-08: a conversation refused on Google's Gemini pool kept the
   instant the refusal named, "Resets in 152h", after an account that could serve Gemini was back, until a paced re-time
   pass came round; a booked move waited behind the account it had been booked onto once that was spent too. */

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

const geminiFleet = async (accounts: readonly TranslatorAccount[]) => {
    const settings = { get: async () => SandboxSettingsSchema.parse({ limitPolicy: "resend" }), onSet: () => () => undefined };
    const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences(), { settings });
    await agents.init();
    const started: TurnInput[] = [];
    const services = unstubbed<Services>("services", {
        agents,
        conversations,
        logger: pino({ level: "silent" }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
        resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({}) }),
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [...accounts] }) }),
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
    const tick = (now: number): Promise<void> => createTurnResumeScheduler(services).tick(now);
    return { agents, conversations, services, started, tick };
};

// Refused on the Gemini pool and held for `reopensAt`, the instant its refusal named; on `account` where one is named.
const refused = async (at: Awaited<ReturnType<typeof geminiFleet>>, over: { readonly account?: string; readonly reopensAt?: number } = {}) => {
    const profile = over.account === undefined ? PROFILE : { ...PROFILE, account: over.account };
    const reopensAt = over.reopensAt ?? FAR;
    await beginTurn(at.conversations, { conversationId: "c1", isolated: true, prompt: PROMPT, profile }, REFUSED_AT);
    const frame = { kind: "error" as const, code: "rate_limit" as const, message: "Resets in 152h", held: { ran: true }, resetsAt: reopensAt, autoResume: "scheduled" as const };
    at.conversations.send("c1", { kind: "frame", frame }, REFUSED_AT);
    const input = { conversationId: "c1", prompt: PROMPT, ...profile, model: MODEL };
    at.conversations.send("c1", { kind: "turn-held", held: { input, reason: "limit", ran: true, reopensAt } }, REFUSED_AT);
    await at.conversations.send("c1", { kind: "settle" }, REFUSED_AT + 10_000).settled;
};

describe("a timed spent-allowance hold, read against the records at every pass", () => {
    // The re-time pass that used to bring it forward ran once a minute, after the pass had already judged the hold.
    it("goes at the very pass that reads an account back that can serve its model, with nothing re-timed first", async () => {
        const at = await geminiFleet([SPENT, BACK]);
        await refused(at);

        await at.tick(NOW);
        expect(at.started.map((turn) => turn.model)).toEqual([MODEL]);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ fired: true, reopensAt: FAR });
    });

    it("keeps its instant while every account is still spent, and goes at it", async () => {
        const at = await geminiFleet([SPENT, STILL_SPENT]);
        await refused(at);

        await at.tick(NOW);
        expect(at.started).toEqual([]);
        expect(at.agents.get("c1")).toMatchObject({ limitResetsAt: FAR, next: { kind: "rerun", at: sendableAt(FAR) } });

        await at.tick(sendableAt(FAR));
        expect(at.started.map((turn) => turn.model)).toEqual([MODEL]);
    });

    // A pick is the person's word on where it goes: it waits for that account, whatever another can serve.
    it("waits on the account a person pointed it at, until that account's reopen", async () => {
        const at = await geminiFleet([SPENT, BACK]);
        await refused(at);
        expect(at.conversations.send("c1", { kind: "held-repointed", account: SPENT.name, carry: true }).reply).toBe(true);

        await at.tick(NOW);
        expect(at.started).toEqual([]);
        expect(at.conversations.state("c1")?.resume.held).toMatchObject({ onto: { account: SPENT.name }, fired: false });
        expect(at.agents.get("c1")?.next).toEqual({ kind: "rerun", at: sendableAt(FAR) });
    });

    // The pass sends it to the account its conversation names, and would only hold it behind that account's wall again.
    it("keeps its instant while the account it would go on is still spent, whatever the others can serve", async () => {
        const at = await geminiFleet([SPENT, BACK]);
        await refused(at, { account: SPENT.name });

        await at.tick(NOW);
        expect(at.started).toEqual([]);
        expect(at.agents.get("c1")?.next).toEqual({ kind: "rerun", at: sendableAt(FAR) });
    });

    // The card's `next` is the rule over the reading the pass left on the hold, so what it says is what the pass does.
    it("states on the card the very instant the pass goes at: the wall in front of it, not the refusal's sooner word", async () => {
        const at = await geminiFleet([SPENT, STILL_SPENT]);
        const sooner = NOW / 1000 + 3_600;
        await refused(at, { reopensAt: sooner });
        // Before any pass has read it, the card says what the refusal said.
        expect(at.agents.get("c1")?.next).toEqual({ kind: "rerun", at: sendableAt(sooner) });

        await at.tick(NOW);
        const next = at.agents.get("c1")?.next;
        expect(next).toEqual({ kind: "rerun", at: sendableAt(FAR) });
        expect(at.agents.get("c1")?.limitResetsAt).toBe(FAR);

        await at.tick(sendableAt(sooner));
        expect(at.started).toEqual([]);
        expect(at.agents.get("c1")?.next).toEqual(next);

        // Past the reset the records named, the wall is gone from them; the grace after it is still waited out.
        await at.tick(FAR * 1000 + 1_000);
        expect(at.started).toEqual([]);
        expect(at.agents.get("c1")?.next).toEqual(next);

        await at.tick(sendableAt(FAR));
        expect(at.started.map((turn) => turn.model)).toEqual([MODEL]);
    });
});

/* A BOOKED MOVE GOES WHERE THERE IS ROOM NOW. The owner's `move` answer books the move at the failure, onto the account
   with room then; the account it goes onto is read again at every pass, so one spent since is passed over for another
   with room, and with none left the hold waits on its own account as a held turn does. */
describe("a booked move whose account is spent since it was booked", () => {
    // Real time: where a move goes is judged by the clock the placement itself reads.
    const T = Math.floor(Date.now() / 1000) * 1000;
    const A_REOPEN = T / 1000 + 3 * 3_600;
    const B_REOPEN = T / 1000 + 5 * 3_600;
    const ACCOUNTS = ["acct-a", "acct-b", "acct-c"].map((id) => ({ id, label: id, connectedAt: 0 }));

    // acct-a refused the turn; acct-b, the account the move was booked onto, refused another since; acct-c has room
    // unless `roomless`.
    const claudeFleet = async (roomless = false) => {
        const settings = { get: async () => SandboxSettingsSchema.parse({ limitPolicy: "move" }), onSet: () => () => undefined };
        const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences(), { settings });
        await agents.init();
        const refusals = [
            claudeLimitRefusal({ account: "acct-a", resetsAt: A_REOPEN, at: T - 120_000 }),
            claudeLimitRefusal({ account: "acct-b", resetsAt: B_REOPEN, at: T - 60_000 }),
            ...(roomless ? [claudeLimitRefusal({ account: "acct-c", resetsAt: B_REOPEN, at: T - 60_000 })] : []),
        ];
        const usage = {
            "acct-b": claudeReading({ five_hour: { utilization: 100, resetsAt: B_REOPEN } }, T - 90_000),
            "acct-c": claudeReading({ five_hour: { utilization: roomless ? 100 : 10, resetsAt: B_REOPEN } }, T - 90_000),
        };
        const started: TurnInput[] = [];
        const services = unstubbed<Services>("services", {
            agents,
            conversations,
            logger: pino({ level: "silent" }),
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: settings.get }),
            resources: unstubbed<Services["resources"]>("resources", { roomSince: async () => undefined }),
            claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => ACCOUNTS }),
            claudeSeats: unstubbed<Services["claudeSeats"]>("claudeSeats", { read: async () => ({}) }),
            accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => usage }),
            providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: refusals }) }),
            accountReach: async () => ACCOUNTS_ALL,
            turns: unstubbed<Services["turns"]>("turns", {
                drain: async () => {},
                start: async (turn) => {
                    started.push(turn);
                    return { id: `run-${started.length}`, async *frames() {} };
                },
            }),
        });
        const profile = { agent: "claude", harness: "native", account: "acct-a" } as const;
        await beginTurn(conversations, { conversationId: "c1", isolated: true, prompt: PROMPT, profile }, T - 120_000);
        const held: HeldOf<"limit"> = {
            input: { conversationId: "c1", prompt: PROMPT, ...profile },
            reason: "limit",
            sessionId: "s-1",
            ran: true,
            reopensAt: A_REOPEN,
            move: { account: "acct-b", carry: true },
        };
        conversations.send("c1", { kind: "frame", frame: { kind: "error", code: "rate_limit", message: "spent", held: { ran: true, moving: "acct-b" }, autoResume: "scheduled" } }, T - 120_000);
        conversations.send("c1", { kind: "turn-held", held }, T - 120_000);
        await conversations.send("c1", { kind: "settle" }, T - 110_000).settled;
        return { agents, conversations, started, tick: (now: number) => createTurnResumeScheduler(services).tick(now) };
    };

    it("goes onto another account with room, with the session the move carries, rather than waiting behind the one booked", async () => {
        const at = await claudeFleet();
        // Before any pass has read it, the card says what the failure booked.
        expect(at.agents.get("c1")?.next).toMatchObject({ kind: "rerun", onto: "acct-b" });

        await at.tick(T);
        expect(at.started.map((turn) => [turn.account, turn.sessionId])).toEqual([["acct-c", "s-1"]]);
    });

    it("waits on its own account's reopen where no account has room, and its card says so", async () => {
        const at = await claudeFleet(true);

        await at.tick(T);
        expect(at.started).toEqual([]);
        expect(at.agents.get("c1")?.next).toEqual({ kind: "rerun", at: sendableAt(A_REOPEN) });
    });
});
