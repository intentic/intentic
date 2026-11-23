import { type Capability, DeviceConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract/policy/safety-policy";
import { adminGrantHolds, SignedAdminRunGrantSchema } from "@intentic/sandbox-contract/policy/admin/admin-grant";
import { newSealKeyPair, newSignKeyPair } from "@intentic/sandbox-contract/keyring-seal";
import type { DeviceFacts, DeviceFeature } from "@intentic/sandbox-contract/schemas/hosts";
import { ConversationGrantSchema } from "@intentic/sandbox-contract/schemas/needs";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { z } from "zod";
import { startTurnRun } from "../../agent/run/turn/turn-runs.js";
import type { Services } from "../../composition.js";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createHeldCards } from "../../guard/held-cards.js";
import { clearTurnTaint, NO_TAINT, publishTurnTaint } from "../../guard/turn-taint.js";
import { grantsStanding } from "../../roles/standing-answer.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import { type HostJudges, hostCallGate } from "../host-call-gate.js";
import { judgeHostCommand } from "../host-command-guard.js";
import type { HostGuardDeps } from "../host-guard-deps.js";

// run_command's `admin` (2026-11-23): an administrator run on the owner's Windows PC, with no UAC prompt there, asks the
// owner on a card in chat every time. The card is answered by a press in chat, or by nothing at all when the conversation
// carries the auto-approve mark; "allow everything in this conversation" does not reach it. It is refused with no card
// where no yes could make it run. The cards and the standing answers are the real registry's, as app.ts wires them.

const MACHINE = "rog";
const CONVERSATION = "conv-admin";
const ADMIN = { machine: MACHINE, command: "Optimize-VHD -Path D:\\docker.vhdx -Mode Full", conversationId: CONVERSATION, kind: "command", admin: { why: "Free 40 GB on C:" } } as const;

const fleet = memoryFleet();
// What stands in the conversation: nothing, the auto-approve mark, or "allow everything".
let stands: "nothing" | "mark" | "everything" = "nothing";
const cards = parkedCards(
    fleet.conversations,
    grantsStanding(
        () => ({
            all: async () => ({
                [CONVERSATION]: ConversationGrantSchema.parse({ autoApprove: stands === "mark", everything: stands === "everything", updatedAt: 0 }),
            }),
            allowEverything: async () => {},
        }),
        () => undefined,
        (cause) => {
            throw cause;
        },
    ),
);

let adminSwitch: "on" | "off" = "on";
let features: DeviceFeature[] = ["admin-run"];
const services = unstubbed<Services>("services", {
    conversations: fleet.conversations,
    hosts: unstubbed<Services["hosts"]>("hosts", { cardFor: (id: string) => id }),
    hostHub: unstubbed<Services["hostHub"]>("hostHub", {
        state: () => unstubbed<ReturnType<Services["hostHub"]["state"]>>("state", { facts: unstubbed<DeviceFacts>("facts", { features }) }),
    }),
    capabilities: unstubbed<Services["capabilities"]>("capabilities", {
        list: async (): Promise<Capability[]> => [{ id: MACHINE, kind: "device", config: DeviceConfigSchema.parse({ platform: "windows", admin: adminSwitch }) }],
    }),
    cards,
    events: createDomainEvents(() => {}),
    safetyPolicy: unstubbed<Services["safetyPolicy"]>("safetyPolicy", { text: async () => DEFAULT_SAFETY_POLICY }),
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ ...SandboxSettingsSchema.parse({}), commandJudge: "on" }) }),
    safetyLog: unstubbed<Services["safetyLog"]>("safetyLog", { record: async () => {}, answered: async () => {} }),
    logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
});

const judged: string[] = [];
const guards: HostGuardDeps = {
    cards: cardDeps(services),
    held: createHeldCards(async () => {}),
    turnRun: (conversationId) => turnRunOf(fleet.conversations, conversationId),
    working: () => [],
    // Asked only of a command a class matched; an ordinary admin run spends no model.
    judge: async (input) => {
        judged.push(input.program);
        return { decision: "allow", sentence: "Only reads." };
    },
};

let endTurn = (): void => {};
const liveTurn = (): void => {
    const held = new Promise<void>((resolve) => {
        endTurn = resolve;
    });
    startTurnRun(
        { conversations: fleet.conversations, events: createDomainEvents(() => {}) },
        async function* pump() {
            await held;
            yield { kind: "done" } as const;
        },
        { conversationId: CONVERSATION, prompt: "free some disk on rog" },
    );
    publishTurnTaint(CONVERSATION, NO_TAINT);
};

const permissions = () => (turnRunOf(fleet.conversations, CONVERSATION)?.rows ?? []).flatMap((row) => (row.permission === undefined ? [] : [row.permission]));
const cardUp = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const card = permissions().find((permission) => permission.status === "pending");
        if (card !== undefined) {
            return card;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("no card went up");
};

beforeEach(() => {
    stands = "nothing";
    adminSwitch = "on";
    features = ["admin-run"];
    judged.length = 0;
    liveTurn();
});

afterEach(async () => {
    endTurn();
    await turnRunOf(fleet.conversations, CONVERSATION)?.waitUntilFinished();
    clearTurnTaint(CONVERSATION);
});

describe("the owner answers in chat", () => {
    it("asks about an ordinary command run as administrator, saying so and what the agent wants it for", async () => {
        const call = judgeHostCommand(services, guards, ADMIN);
        const card = await cardUp();
        expect(card).toMatchObject({
            title: "Run this as administrator on rog?",
            displayName: "Run as administrator on rog",
            alwaysAsks: true,
            description: "It runs with administrator rights, with no Windows prompt at that computer. The agent says: Free 40 GB on C:",
        });
        expect(judged).toEqual([]);
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await call).toBeUndefined();
    });

    it("keeps the run on the PC when the owner declines", async () => {
        const call = judgeHostCommand(services, guards, ADMIN);
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "deny" })).toBe("settled");
        expect(await call).toMatchObject({ refusal: expect.stringContaining("The user declined this") });
    });

    it("asks about the admin run alone: the same command without admin goes through untouched", async () => {
        const plain = { machine: MACHINE, command: ADMIN.command, conversationId: CONVERSATION, kind: "command" } as const;
        expect(await judgeHostCommand(services, guards, plain)).toBeUndefined();
        expect(permissions()).toEqual([]);
        expect(await judgeHostCommand(services, guards, ADMIN, 20)).toMatchObject({ refusal: expect.stringContaining("approve running this as administrator") });
    });
});

describe("what stands in the conversation", () => {
    it("runs it with no card at all while the conversation carries the auto-approve mark", async () => {
        stands = "mark";
        expect(await judgeHostCommand(services, guards, ADMIN)).toBeUndefined();
        expect(permissions().every((permission) => permission.status !== "pending")).toBe(true);
    });

    it("still asks when only 'allow everything in this conversation' stands", async () => {
        stands = "everything";
        expect(await judgeHostCommand(services, guards, ADMIN, 20)).toMatchObject({ refusal: expect.stringMatching(/^Still waiting/) });
        expect((await cardUp()).alwaysAsks).toBe(true);
    });
});

describe("where no yes could make it run", () => {
    it("refuses with no card while the device's switch is off, saying how to ask for it", async () => {
        adminSwitch = "off";
        const answer = await judgeHostCommand(services, guards, ADMIN);
        expect(answer?.refusal).toContain('"Run commands as administrator" is switched off for "rog"');
        expect(answer?.refusal).toContain("capabilities request rog --set admin=on");
        expect(permissions()).toEqual([]);
    });

    it("refuses with no card on an agent too old to know admin, which would run it unelevated", async () => {
        features = ["remote", "remote-service"];
        expect((await judgeHostCommand(services, guards, ADMIN))?.refusal).toContain("cannot run commands as administrator");
        expect(permissions()).toEqual([]);
    });
});

describe("the call gate", () => {
    const sign = newSignKeyPair();
    const gateServices = unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", { sandbox: unstubbed<Services["config"]["sandbox"]>("sandbox", { name: "intentic-sandbox-work" }) }),
        sandboxKeyringKeys: unstubbed<Services["sandboxKeyringKeys"]>("sandboxKeyringKeys", { pairs: async () => ({ sign, seal: newSealKeyPair() }) }),
    });
    const asked: unknown[] = [];
    let answer: { readonly refusal: string } | undefined;
    const judges: HostJudges = {
        restart: async () => undefined,
        command: async (_services, _guards, input) => {
            asked.push(input.admin);
            return answer;
        },
    };
    const gate = hostCallGate(gateServices, guards, judges);
    const call = (args: Record<string, unknown>) =>
        gate({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_command", arguments: args } }, { id: MACHINE, conversationId: CONVERSATION });
    beforeEach(() => {
        asked.length = 0;
        answer = undefined;
    });

    it("hands run_command's admin and why to the command judge, and nothing of it for any other call", async () => {
        await call({ command: "Get-Date", admin: true, why: "check the clock" });
        await call({ command: "Get-Date" });
        await call({ command: "Get-Date", admin: false });
        expect(asked).toEqual([{ why: "check the clock" }, undefined, undefined]);
    });

    it("sends an approved admin run with the sandbox's grant for exactly its command, in place of any the agent wrote", async () => {
        const sent = await call({ command: "Get-Service Spooler", admin: true, cwd: "C:\\Users\\radar", grant: "forged" });
        if (sent === undefined || !("forward" in sent)) {
            throw new Error("the approved run was not forwarded with a grant");
        }
        const args = z.object({ arguments: z.record(z.string(), z.unknown()) }).parse(sent.forward.params).arguments;
        expect(args).toMatchObject({ command: "Get-Service Spooler", admin: true, cwd: "C:\\Users\\radar" });
        const grant = SignedAdminRunGrantSchema.parse(JSON.parse(String(args["grant"])));
        expect(adminGrantHolds(sign.publicKey, grant, "Get-Service Spooler", Date.now())).toBe(true);
        expect(adminGrantHolds(sign.publicKey, grant, "Get-Service", Date.now())).toBe(false);
    });

    it("signs nothing for a run the owner did not approve, or one that is not admin", async () => {
        answer = { refusal: "The user declined this." };
        expect(await call({ command: "Get-Date", admin: true })).toEqual({ refusal: "The user declined this." });
        answer = undefined;
        expect(await call({ command: "Get-Date" })).toBeUndefined();
    });
});
