import { unstubbed } from "@intentic/testing";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Services } from "../../../../composition.js";
import { memoryStartWindow } from "../../../../store/start-window.testing.js";
import { beginTurn } from "../../../../conversations/actor/conversation-actors.testing.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { messageConversation } from "../../../../conversations/recall/fleet-message.js";
import { messageDaemon } from "../../../../conversations/recall/fleet-message.testing.js";
import { memorySeats, scriptedSeatCheck, seededRefusals, STILL_OFF } from "../../../providers/claude/claude-seat-check.testing.js";
import * as harnessCredentialsOriginal from "../../../providers/harness-credentials.js";
import { planTurn } from "../turn-plan.js";
import { context, harnessServices } from "../turn-plan.testing.js";

/* THE INCIDENT, REPLAYED (2026-10-28, deft-reef-zwn8). The conversation had last run on a Claude account whose
   organisation then switched Claude Code off. The refusal ledger had said so since 08:48, and a second account had room.
   A peer's `agents message` opened a turn on the conversation anyway, on the refused account: the message copied the
   remembered account into the turn, where it read as a person's choice, which is never moved. It was refused, re-sent,
   and refused again, and the owner had to switch accounts by hand, which also threw the session away.
   Now: the message names no account, planning moves the turn and the conversation to the account with room, and the
   session the conversation had is the one the turn resumes. */

const credentials = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
jest.mock("../../../providers/harness-credentials.js", async () => ({
    ...harnessCredentialsOriginal,
    resolveHarnessCredentials: (...args: unknown[]) => credentials(...args),
}));

beforeEach(() => {
    credentials.mockReset();
    credentials.mockResolvedValue({ ok: true, credentials: { oauthToken: "sk-oauth", account: "personal" } });
});

const REFUSED: ProviderRefusal = {
    at: Date.now() - 6 * 60 * 60_000,
    kind: "entitlement",
    message: "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access",
    account: "work",
    model: "claude-opus-5-5",
};

test("a peer's message to a conversation on a refused account runs on the account with room, in the same session", async () => {
    // The conversation as it stood: last turn on `work`, its session minted there, quiet since.
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "deft-reef", isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native", model: "claude-opus-5-5", account: "work" } }, 1);
    fleet.conversations.send("deft-reef", { kind: "frame", frame: { kind: "session", sessionId: "sess-deft", account: "work" } });
    await fleet.conversations.send("deft-reef", { kind: "settle" }, 2).settled;

    // The peer's message, as the door hands it to the turn engine.
    const { services: doors, started } = messageDaemon(fleet);
    expect(await messageConversation(doors, "stout-raven", "deft-reef", "Fly support replied", memoryStartWindow())).toMatchObject({ ok: true });
    const [sent] = started;
    expect(sent).toMatchObject({ conversationId: "deft-reef", agent: "claude", model: "claude-opus-5-5", sessionId: "sess-deft" });
    expect(sent?.account).toBeUndefined();

    // Planning it: the ledger's refusal stands against `work`, and `personal` has room.
    const moves: [string, string][] = [];
    const seats = memorySeats({});
    const roomy = { measuredAt: Date.now(), windows: [{ kind: "five_hour" as const, utilization: 20, gates: "all" as const }] };
    const planning = harnessServices({
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => fleet.agents.entry("deft-reef"),
            switchAccount: async (id: string, account: string) => {
                moves.push([id, account]);
                return undefined;
            },
        }),
        claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", {
            list: async () => [
                { id: "work", label: "work", connectedAt: 0 },
                { id: "personal", label: "personal", connectedAt: 1 },
            ],
        }),
        claudeSeats: seats,
        // The re-test reads the same ledger, and the provider still says no.
        claudeSeatCheck: scriptedSeatCheck({ seats, refusals: seededRefusals({ claude: [REFUSED] }), answer: () => STILL_OFF }).check,
        accountUsage: unstubbed<Services["accountUsage"]>("accountUsage", { read: async () => ({ work: roomy, personal: roomy }) }),
        providerRefusals: unstubbed<Services["providerRefusals"]>("providerRefusals", { onFile: async () => ({ claude: [REFUSED] }) }),
    });
    if (sent === undefined) {
        throw new Error("the message opened no turn");
    }
    const plan = await planTurn(planning, sent, context);

    expect(plan.ok).toBe(true);
    expect(credentials).toHaveBeenCalledWith(planning, expect.objectContaining({ account: "personal" }));
    expect(moves).toEqual([["deft-reef", "personal"]]);
});
