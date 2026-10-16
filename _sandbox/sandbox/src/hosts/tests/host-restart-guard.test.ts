import { AgentAttentionSchema, type AgentSummary, AgentSummarySchema } from "@intentic/sandbox-contract/schemas/agents";
import { type Capability, DeviceConfigSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { ProgramArgumentsSchema, type ProgramReading, programInCall } from "@intentic/sandbox-contract/policy/device-programs";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { startTurnRun } from "../../agent/run/turn/turn-runs.js";
import { openSpawnedChild, resetSubagents } from "../../agent/subagents/subagents.js";
import { workingNames } from "../../bootstrap/working-now.js";
import type { Services } from "../../composition.js";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { clearTurnTaint, NO_TAINT, publishTurnTaint } from "../../guard/turn-taint.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createHeldCards } from "../../guard/held-cards.js";
import type { HostGuardDeps } from "../host-guard-deps.js";
import { DeviceToolCallSchema, judgeHostRestart, restartInCall, restartInProgram } from "../host-restart-guard.js";

// An agent restarting the sandbox it and the rest of the fleet run in, through a device tool or as a shell command: the
// owner is asked on a card naming what it would stop, whenever anything else is in flight. The orchestrator's rebuild
// that cut four agents at once is the case this pins; the sandbox's one answer to "is it busy?" (workingNames) is what
// decides, so a land or a running subagent is cut no more than a turn is.

const MACHINE = "rog";
const CALLER = "conv-orchestrator";
const OTHER = "conv-ledgerly";
const IDLE = "conv-finished";
const SHIPPING = "conv-shipping";
const REBUILD = { tool: "swap_sandbox", op: "rebuild", doing: "Rebuild" };
const ASKED = { machine: MACHINE, call: REBUILD, conversationId: CALLER };

const fleet = memoryFleet();
const cards = parkedCards(fleet.conversations);

// The board's rows for the three conversations; which of them is mid-turn is the actors' own reading, not this list's.
const summary = (id: string, title: string): AgentSummary =>
    AgentSummarySchema.parse({
        id,
        title,
        status: "idle",
        provider: "claude",
        harness: "native",
        updatedAt: 0,
        // Waiting on nobody, in every way the schema knows.
        attention: AgentAttentionSchema.parse(Object.fromEntries(AgentAttentionSchema.keyof().options.map((kind) => [kind, false]))),
    });

// The device's own "Manage sandboxes on this device" switch, on unless a test says otherwise: a card only goes up for a
// restart the device itself would then carry out.
let sandboxes: "on" | "off" = "on";
const deviceCard = (): Capability => ({
    id: MACHINE,
    kind: "device",
    config: DeviceConfigSchema.parse({ platform: "linux", sandboxes }),
});

const services = unstubbed<Services>("services", {
    conversations: fleet.conversations,
    agents: unstubbed<Services["agents"]>("agents", {
        list: () => [summary(CALLER, "ORCHESTRATOR"), summary(OTHER, "LEDGERLY"), summary(IDLE, "Done already"), summary(SHIPPING, "Shipping the docs")],
    }),
    hosts: unstubbed<Services["hosts"]>("hosts", { cardFor: (id: string) => id }),
    capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [deviceCard()] }),
    cards,
    events: createDomainEvents(() => {}),
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () => ({ ...SandboxSettingsSchema.parse({}), autoResumeOnRestart }),
    }),
});

// What the gate takes from above the host layer, as app.ts fills it: the real cards and the published turn.
const guards: HostGuardDeps = {
    cards: cardDeps(services),
    // A restart card is not held for the turn's close: nothing here registers one.
    held: createHeldCards(async () => {}),
    turnRun: (conversationId) => turnRunOf(fleet.conversations, conversationId),
    // The daemon's one answer to what a restart would cut, as app.ts fills it.
    working: (except) => workingNames(services, "restart", except),
    // A restart is never put to the judge.
    judge: async () => {
        throw new Error("a restart is not judged");
    },
};
// The owner's "pick up again after a restart" switch, off as it ships.
let autoResumeOnRestart = false;

// Each conversation's turn, held open by the real pump until the test ends it; the caller's is attended.
const ends = new Map<string, () => void>();
const liveTurn = (conversationId: string): void => {
    const held = new Promise<void>((resolve) => ends.set(conversationId, resolve));
    startTurnRun(
        { conversations: fleet.conversations, events: createDomainEvents(() => {}) },
        async function* pump() {
            await held;
            yield { kind: "done" } as const;
        },
        { conversationId, prompt: "work" },
    );
};
const endTurn = async (conversationId: string): Promise<void> => {
    ends.get(conversationId)?.();
    await turnRunOf(fleet.conversations, conversationId)?.waitUntilFinished();
};

// The card the gate raised on the caller's turn, once it is up.
const cardUp = async (): Promise<{
    readonly requestId: string;
    readonly title: string | undefined;
    readonly description: string | undefined;
    readonly toolName: string;
    readonly program: string | undefined;
}> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const card = turnRunOf(fleet.conversations, CALLER)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.status === "pending");
        if (card !== undefined) {
            return { requestId: card.requestId, title: card.title, description: card.description, toolName: card.toolName, program: card.program?.text };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the gate raised no card on the turn");
};

beforeEach(() => {
    liveTurn(CALLER);
    publishTurnTaint(CALLER, NO_TAINT);
});

afterEach(async () => {
    await endTurn(CALLER);
    await endTurn(OTHER);
    await endTurn(IDLE);
    clearTurnTaint(CALLER);
    resetSubagents(fleet.conversations);
    autoResumeOnRestart = false;
    sandboxes = "on";
});

describe("which calls restart this sandbox", () => {
    // As the bridge hands it over: a JSON-RPC message, parsed by the gate's own schema.
    const call = (name: string, args: Record<string, string | number | boolean>) =>
        DeviceToolCallSchema.parse({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

    it("names the swaps, a restart or stop, and new resources applied now, on this sandbox's own slug", () => {
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "work", hash: "abc" }), "work")).toEqual(REBUILD);
        expect(restartInCall(call("swap_sandbox", { op: "update", slug: "work" }), "work")).toEqual({
            tool: "swap_sandbox",
            op: "update",
            doing: "Update",
        });
        expect(restartInCall(call("manage_sandbox", { op: "stop", slug: "work" }), "work")).toEqual({
            tool: "manage_sandbox",
            op: "stop",
            doing: "Stop",
        });
        // Removing this sandbox stops every turn in it too.
        expect(restartInCall(call("remove_sandbox", { slug: "work" }), "work")).toEqual({ tool: "remove_sandbox", op: "remove", doing: "Remove" });
        expect(restartInCall(call("reshape_sandbox", { slug: "work", when: "now", cpus: 4 }), "work")).toEqual({
            tool: "reshape_sandbox",
            op: "now",
            doing: "Restart with new resources",
        });
    });

    // On Intentic OS a reboot of the machine stops every sandbox on it, and names none: read as possibly this one.
    it("names a reboot of an Intentic OS machine, whichever tool asks for it, and nothing that only stages", () => {
        expect(restartInCall(call("os_reboot", {}), "work")).toEqual({ tool: "os_reboot", op: "os-reboot", doing: "Reboot the machine running" });
        expect(restartInCall(call("os_update", { op: "apply" }), "work")).toEqual({ tool: "os_update", op: "os-update", doing: "Update and reboot the machine running" });
        expect(restartInCall(call("os_rollback", { apply: true }), "work")).toEqual({
            tool: "os_rollback",
            op: "os-rollback",
            doing: "Roll back and reboot the machine running",
        });
        for (const [name, args] of [
            ["os_update", { op: "stage" }],
            ["os_update", { op: "check" }],
            ["os_rollback", {}],
            ["os_rollback", { apply: false }],
            ["os_channel", { channel: "beta" }],
            ["os_status", {}],
        ] as const) {
            expect(restartInCall(call(name, args), "work"), `${name} ${JSON.stringify(args)}`).toBeUndefined();
        }
        // A bare dev run has no container name, so no slug of its own to protect.
        expect(restartInCall(call("os_reboot", {}), undefined)).toBeUndefined();
    });

    it("reads no call it cannot parse: a notification carries no id to answer", () => {
        expect(DeviceToolCallSchema.safeParse({ jsonrpc: "2.0", method: "tools/call", params: { name: "swap_sandbox" } }).success).toBe(false);
    });

    it("leaves alone what stops no turn here: another sandbox, a download, a start, resources saved for later", () => {
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "other" }), "work")).toBeUndefined();
        expect(restartInCall(call("swap_sandbox", { op: "prepare", slug: "work" }), "work")).toBeUndefined();
        expect(restartInCall(call("manage_sandbox", { op: "start", slug: "work" }), "work")).toBeUndefined();
        expect(restartInCall(call("reshape_sandbox", { slug: "work", when: "nextRestart" }), "work")).toBeUndefined();
        // A bare dev run has no container name, so no slug of its own to protect.
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "work" }), undefined)).toBeUndefined();
    });
});

describe("nobody else is working", () => {
    it("forwards the call: the caller alone is stopped, and it chose to be", async () => {
        expect(await judgeHostRestart(services, guards, ASKED)).toBeUndefined();
        expect(turnRunOf(fleet.conversations, CALLER)?.rows.filter((row) => row.permission !== undefined)).toEqual([]);
    });
});

describe("another agent is mid-turn", () => {
    beforeEach(() => liveTurn(OTHER));

    it("asks the owner on a card naming who it stops, and forwards the call once they allow it", async () => {
        const judged = judgeHostRestart(services, guards, ASKED);
        const card = await cardUp();
        expect(card.title).toBe("Rebuild this sandbox now?");
        expect(card.description).toBe(
            "It restarts the sandbox on rog, which stops the agent working in it now: LEDGERLY. Its work is kept, and it waits to be continued once the sandbox is back.",
        );
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await judged).toBeUndefined();
    });

    it("says the stopped agents pick up by themselves where the owner turned that on", async () => {
        autoResumeOnRestart = true;
        liveTurn(IDLE);
        const judged = judgeHostRestart(services, guards, ASKED);
        const card = await cardUp();
        expect(card.description).toBe(
            "It restarts the sandbox on rog, which stops the 2 agents working in it now: LEDGERLY, Done already. They pick up again by themselves once the sandbox is back.",
        );
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await judged).toBeUndefined();
    });

    it("hands the agent the owner's no, and tells it not to find another way", async () => {
        const judged = judgeHostRestart(services, guards, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "deny" })).toBe("settled");
        expect(await judged).toEqual({
            refusal: "The owner declined: not now. Do not restart the sandbox another way; say what is left undone until it can be.",
        });
    });

    it("holds it without a card when nobody is in the turn to ask", async () => {
        clearTurnTaint(CALLER);
        expect(await judgeHostRestart(services, guards, ASKED)).toEqual({
            refusal:
                "Held for the owner: this would restart the sandbox you run in, which stops 1 other agent working now (LEDGERLY), and there is " +
                "nobody in this turn to ask. Do not retry it unasked: ask the owner in chat, or wait until they are idle.",
        });
    });

    it("answers before the agent's client gives up, and the same call again collects the owner's yes", async () => {
        expect(await judgeHostRestart(services, guards, ASKED, 20)).toEqual({
            refusal:
                'Still waiting for the owner: a card asks them to approve swap_sandbox rebuild on "rog", and nothing has run yet. Their answer is ' +
                "kept for this exact call: make it again with the same arguments to wait for it. Do not restart the sandbox another way.",
        });
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "once" })).toBe("settled");
        expect(await judgeHostRestart(services, guards, ASKED, 20)).toBeUndefined();
    });
});

describe("work that is not a turn", () => {
    // A land holds nothing the turn pump knows of, which is why the guard's own list of turns once cut it unasked.
    it("asks about a land in flight, and names it, though no turn is running", async () => {
        let finishLanding = (): void => {};
        const landing = fleet.conversations.withLandLease(
            SHIPPING,
            () =>
                new Promise<void>((resolve) => {
                    finishLanding = resolve;
                }),
        );
        try {
            const judged = judgeHostRestart(services, guards, ASKED);
            const card = await cardUp();
            expect(card.description).toBe(
                "It restarts the sandbox on rog, which stops the agent working in it now: Shipping the docs. Its work is kept, and it waits to be continued once the sandbox is back.",
            );
            expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
            expect(await judged).toBeUndefined();
        } finally {
            finishLanding();
            await landing;
        }
    });

    it("leaves the caller's own turn out of what it says it stops, and no one else's", () => {
        liveTurn(OTHER);
        expect(workingNames(services, "restart")).toEqual(["ORCHESTRATOR", "LEDGERLY"]);
        expect(workingNames(services, "restart", CALLER)).toEqual(["LEDGERLY"]);
        expect(workingNames(services, "restart", OTHER)).toEqual(["ORCHESTRATOR"]);
    });
});

describe("a running subagent", () => {
    // Started by another conversation's turn, and one that is the caller itself (a spawned child restarting the ground it runs on).
    const startedBy = (conversationId: string, id: string, description: string): void =>
        openSpawnedChild({ conversationId, conversations: fleet.conversations, subagentsDir: undefined }, { id, description });

    it("holds the restart like a turn does, and the caller's own record is not other work", () => {
        startedBy(OTHER, "conv-child", "Port the parser");
        startedBy(OTHER, CALLER, "Run the migration");
        expect(workingNames(services, "restart").toSorted()).toEqual(["ORCHESTRATOR", "Port the parser", "Run the migration"]);
        expect(workingNames(services, "restart", CALLER)).toEqual(["Port the parser"]);
    });
});

describe("the same restart spelled as a shell command", () => {
    const OWN = { slug: "work", container: "intentic-sandbox-work" };
    const SHELL = { tool: "run_command", op: "restart", doing: "Restart", commandLine: "ic sandbox restart work" };
    const read = (tool: string, args: Record<string, unknown>): ProgramReading => {
        const reading = programInCall(tool, ProgramArgumentsSchema.parse(args));
        if (reading === undefined) {
            throw new Error(`${tool} carries no program in ${JSON.stringify(args)}`);
        }
        return reading;
    };

    it("is named from run_command, app_start with arguments, and typed text, on this sandbox's slug or its container", () => {
        expect(restartInProgram(read("run_command", { command: "ic sandbox restart work" }), OWN)).toEqual(SHELL);
        expect(restartInProgram(read("run_command", { command: "docker stop intentic-sandbox-work" }), OWN)).toEqual({
            tool: "run_command",
            op: "stop",
            doing: "Stop",
            commandLine: "docker stop intentic-sandbox-work",
        });
        expect(restartInProgram(read("run_command", { command: "ic sandbox rebuild work 3f2a --no-resume" }), OWN)).toMatchObject({ op: "rebuild", doing: "Rebuild" });
        expect(restartInProgram(read("run_command", { command: "ic sandbox rollback work" }), OWN)).toMatchObject({ op: "rollback", doing: "Roll back" });
        expect(restartInProgram(read("run_command", { command: "ic sandbox rm work -y" }), OWN)).toMatchObject({ op: "remove", doing: "Remove" });
        expect(restartInProgram(read("app_start", { program: "powershell", args: ["-c", "ic sandbox update work"] }), OWN)).toEqual({
            tool: "app_start",
            op: "update",
            doing: "Update",
            commandLine: "powershell -c 'ic sandbox update work'",
        });
        expect(restartInProgram(read("device", { action: "type", text: "ic sandbox restart work\n" }), OWN)).toMatchObject({ tool: "device", op: "restart" });
    });

    it("reads generously: a command that names no sandbox, or works the name out as it runs, may be this one", () => {
        for (const command of [
            "ic sandbox update",
            "ic sandbox restart",
            "docker stop $(docker ps -q)",
            "docker ps -q | xargs docker stop",
            "ic sandbox remove --all -y",
            // An Intentic OS machine rebooting stops every sandbox on it.
            "ic os reboot",
            "ic os update --apply",
            "sudo bootc upgrade --apply",
        ]) {
            expect(restartInProgram(read("run_command", { command }), OWN), command).toMatchObject({ tool: "run_command" });
        }
    });

    it("leaves alone another sandbox, what stops nothing, a phone's shell, and an unnamed sandbox of our own", () => {
        for (const command of [
            "ic sandbox restart other",
            "docker restart postgres",
            "ic sandbox start work",
            "ic sandbox prepare work --auto",
            "ic sandbox shape work --set cpus=4 --when next-restart",
            "ic sandbox list --json",
            "docker logs intentic-sandbox-work",
            "docker start intentic-sandbox-work",
            "ic os update",
            "ic os channel beta",
            "ic os status --json",
        ]) {
            expect(restartInProgram(read("run_command", { command }), OWN), command).toBeUndefined();
        }
        expect(restartInProgram(read("android_shell", { command: "docker stop intentic-sandbox-work" }), OWN)).toBeUndefined();
        // A bare dev run has no container name, so no slug of its own to protect.
        expect(restartInProgram(read("run_command", { command: "ic sandbox restart work" }), undefined)).toBeUndefined();
    });

    it("asks the owner on a card showing the command, and forwards the call once they allow it", async () => {
        liveTurn(OTHER);
        const judged = judgeHostRestart(services, guards, { machine: MACHINE, call: SHELL, conversationId: CALLER });
        const card = await cardUp();
        expect(card).toMatchObject({
            title: "Restart this sandbox now?",
            toolName: "rog__run_command",
            program: "ic sandbox restart work",
            description:
                "It restarts the sandbox on rog, which stops the agent working in it now: LEDGERLY. Its work is kept, and it waits to be continued once the sandbox is back.",
        });
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await judged).toBeUndefined();
    });

    it("keeps the owner's answer for that command alone", async () => {
        liveTurn(OTHER);
        expect(await judgeHostRestart(services, guards, { machine: MACHINE, call: SHELL, conversationId: CALLER }, 20)).toMatchObject({
            refusal: expect.stringMatching(/^Still waiting for the owner: a card asks them to approve run_command restart on "rog"/),
        });
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "once" })).toBe("settled");
        // The same restart from another command is a different call, asked about afresh.
        const other = { ...SHELL, commandLine: "ic sandbox restart work --no-resume" };
        expect(await judgeHostRestart(services, guards, { machine: MACHINE, call: other, conversationId: CALLER }, 20)).toMatchObject({
            refusal: expect.stringMatching(/^Still waiting for the owner/),
        });
        expect(await judgeHostRestart(services, guards, { machine: MACHINE, call: SHELL, conversationId: CALLER }, 20)).toBeUndefined();
    });

    it("forwards the command when nothing else is in flight", async () => {
        expect(await judgeHostRestart(services, guards, { machine: MACHINE, call: SHELL, conversationId: CALLER })).toBeUndefined();
    });
});

describe("the device would refuse it anyway", () => {
    beforeEach(() => liveTurn(OTHER));

    it("refuses at once, naming the switch, rather than asking for a yes the device cannot honour", async () => {
        sandboxes = "off";
        expect(await judgeHostRestart(services, guards, ASKED)).toEqual({
            refusal:
                'Refused: this would rebuild the sandbox you run in on "rog", and its "Manage sandboxes on this device" switch is off, so the device would refuse it even if the owner approved. ' +
                "Ask the owner to turn on \"Manage sandboxes on this device\" in rog's capability card. Do not look for another spelling that gets past it.",
        });
        expect(turnRunOf(fleet.conversations, CALLER)?.rows.filter((row) => row.permission !== undefined)).toEqual([]);
    });
});
