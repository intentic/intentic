import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../../composition.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { holdOf, waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import { claudeReading } from "../../../providers/claude/claude-usage.testing.js";
import { BACK_ON, memorySeats, scriptedSeatCheck, STILL_OFF } from "../../../providers/claude/claude-seat-check.testing.js";
import type { SeatProbe } from "../../../providers/claude/claude-seat-check.js";
import { releaseAccountHolds } from "./account-refusal-release.js";

// The shinobi-society audit (2026-11-17): a Claude account whose organisation turned Claude Code off refused the turn at
// the door, its words went back to the queue held for a press, and the conversation sat for hours beside a second
// account that could have served it. The resume pass now lets them go when the provider can serve them.

const CONVERSATION = "quiet-heron-abcd";
const SEAT_OFF = { home: { at: 0, reason: "Your organization has disabled Claude Code." } };
// SAFETY: the rule reads only an account's id and label; the rest of a stored row is the store's own business.
const TWO = [
    { id: "home", label: "home" },
    { id: "spare", label: "spare" },
] as OauthAccount[];

const setup = (params: {
    readonly accounts?: readonly OauthAccount[];
    readonly usage?: Record<string, AccountUsage>;
    readonly code?: string;
    readonly probe?: SeatProbe;
    readonly turn?: { readonly account?: string; readonly accountPicked?: true; readonly speaker?: { readonly kind: "person"; readonly email: string } };
}) => {
    const { conversations } = memoryFleet();
    const seats = { ...SEAT_OFF };
    const drained: string[] = [];
    const services = unstubbed<Services>("services", {
        conversations,
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) =>
                id === CONVERSATION
                    ? unstubbed<NonNullable<ReturnType<Services["agents"]["entry"]>>>("entry", {
                          ending: { kind: "failed", code: params.code ?? "claude-not-entitled", failure: "refused" },
                          profile: unstubbed("profile", { provider: "claude", harness: "claude-code", account: "home" }),
                      })
                    : undefined,
        }),
        turns: unstubbed<Services["turns"]>("turns", {
            drain: async (id: string) => {
                drained.push(id);
            },
        }),
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", { list: async () => [...(params.accounts ?? TWO)] }),
        claudeSeats: memorySeats(seats),
        claudeSeatCheck: scriptedSeatCheck({ seats: memorySeats(seats), answer: () => params.probe ?? STILL_OFF }).check,
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => params.usage ?? {} }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({}), flapping: async () => new Set<string>() }),
        providerAccounts: async () => [],
        cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {}),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
    conversations.send(CONVERSATION, {
        kind: "queue-returned",
        items: [
            {
                id: "m-1",
                voice: "person",
                queuedAt: 1,
                turn: { conversationId: CONVERSATION, prompt: "carry on", agent: "claude", harness: "claude-code", ...params.turn },
            },
        ],
    });
    const held = (): boolean => holdOf(conversations.queued(CONVERSATION)) === "refused" && waitingOf(conversations.queued(CONVERSATION)).length > 0;
    return { services, drained, held };
};

test("the words go again by themselves once another account of the provider can take them", async () => {
    const { services, drained, held } = setup({ usage: { spare: claudeReading({ five_hour: { utilization: 30 } }) } });
    expect(held()).toBe(true);
    await releaseAccountHolds(services, Date.now());
    expect(drained).toEqual([CONVERSATION]);
    expect(held()).toBe(false);
});

test("an account with no fresh reading takes them when every account with one is refused", async () => {
    const { services, drained } = setup({});
    await releaseAccountHolds(services, Date.now());
    expect(drained).toEqual([CONVERSATION]);
});

test("they go again on the same account once a re-test finds its seat back on", async () => {
    const { services, drained } = setup({ accounts: TWO.slice(0, 1), probe: BACK_ON });
    await releaseAccountHolds(services, Date.now());
    expect(drained).toEqual([CONVERSATION]);
});

test("with nowhere to serve them, a pick of the refused account, or another refusal, they wait for a press", async () => {
    const nowhere = setup({ usage: { spare: claudeReading({ five_hour: { utilization: 100 } }) } });
    await releaseAccountHolds(nowhere.services, Date.now());
    expect(nowhere.drained).toEqual([]);
    expect(nowhere.held()).toBe(true);

    const picked = setup({ turn: { account: "home", accountPicked: true, speaker: { kind: "person", email: "owner@example.com" } } });
    await releaseAccountHolds(picked.services, Date.now());
    expect(picked.drained).toEqual([]);

    const other = setup({ code: "account-not-allowed" });
    await releaseAccountHolds(other.services, Date.now());
    expect(other.drained).toEqual([]);
});
