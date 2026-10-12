import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { type HostJudges, hostCallGate } from "../host-call-gate.js";
import type { HostGuardDeps } from "../host-guard-deps.js";

// The two questions put to every call headed for the owner's computer, and the order they are asked in: does it restart
// the sandbox the other agents run in, and does it carry a program the safety policy has a view on. The judges are
// fakes here that record what they were handed; what each of them decides is pinned in its own suite.

const MACHINE = "rog";
const CONVERSATION = "conv-gate";
const CONTAINER = "intentic-sandbox-work";

const services = unstubbed<Services>("services", {
    config: unstubbed<Services["config"]>("config", { sandbox: unstubbed<Services["config"]["sandbox"]>("sandbox", { name: CONTAINER }) }),
});
const guards = unstubbed<HostGuardDeps>("guards", {});

// Each judge's answer for the next call, and what each was asked.
let restartAnswer: { readonly refusal: string } | undefined;
let commandAnswer: { readonly refusal: string } | undefined;
const asked: { readonly judge: "restart" | "command"; readonly what: unknown }[] = [];
const judges: HostJudges = {
    restart: async (_services, _guards, input) => {
        asked.push({ judge: "restart", what: { machine: input.machine, call: input.call, conversationId: input.conversationId } });
        return restartAnswer;
    },
    command: async (_services, _guards, input) => {
        asked.push({ judge: "command", what: { machine: input.machine, command: input.command, kind: input.kind, conversationId: input.conversationId } });
        return commandAnswer;
    },
};
const gate = hostCallGate(services, guards, judges);

const toolCall = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
const through = (name: string, args: Record<string, unknown>) => gate(toolCall(name, args), { id: MACHINE, conversationId: CONVERSATION });

beforeEach(() => {
    restartAnswer = undefined;
    commandAnswer = undefined;
    asked.length = 0;
});

describe("a call that carries nothing to judge", () => {
    it("goes straight through: a notification, a tool with no program, a read of the sandboxes", async () => {
        expect(await gate({ jsonrpc: "2.0", method: "tools/call", params: { name: "run_command", arguments: { command: "rm -rf ~" } } }, { id: MACHINE, conversationId: CONVERSATION })).toBeUndefined();
        expect(await gate("not even a message", { id: MACHINE, conversationId: CONVERSATION })).toBeUndefined();
        expect(await through("read_file", { path: "/etc/hosts" })).toBeUndefined();
        expect(await through("list_sandboxes", {})).toBeUndefined();
        expect(await through("manage_sandbox", { op: "stop", slug: "other" })).toBeUndefined();
        expect(asked).toEqual([]);
    });
});

describe("a restart of this sandbox by the device's own tool", () => {
    it("is put to the restart judge alone, and its refusal is the answer", async () => {
        restartAnswer = { refusal: "Held for the owner." };
        expect(await through("swap_sandbox", { op: "rebuild", slug: "work", hash: "abc" })).toEqual({ refusal: "Held for the owner." });
        expect(asked).toEqual([
            {
                judge: "restart",
                what: { machine: MACHINE, call: { tool: "swap_sandbox", op: "rebuild", doing: "Rebuild" }, conversationId: CONVERSATION },
            },
        ]);
    });

    it("is forwarded when the owner allows it, and carries no program for the command judge", async () => {
        expect(await through("manage_sandbox", { op: "restart", slug: "work" })).toBeUndefined();
        expect(asked.map((entry) => entry.judge)).toEqual(["restart"]);
    });
});

describe("the same restart spelled as a command", () => {
    it("is put to the restart judge, then to the command judge once the owner allows it", async () => {
        expect(await through("run_command", { command: "ic sandbox restart work" })).toBeUndefined();
        expect(asked).toEqual([
            {
                judge: "restart",
                what: {
                    machine: MACHINE,
                    call: { tool: "run_command", op: "restart", doing: "Restart", commandLine: "ic sandbox restart work" },
                    conversationId: CONVERSATION,
                },
            },
            { judge: "command", what: { machine: MACHINE, command: "ic sandbox restart work", kind: "command", conversationId: CONVERSATION } },
        ]);
    });

    it("never reaches the command judge when the owner refuses the restart", async () => {
        restartAnswer = { refusal: "The owner declined: not now." };
        expect(await through("run_command", { command: "docker stop intentic-sandbox-work" })).toEqual({ refusal: "The owner declined: not now." });
        expect(asked.map((entry) => entry.judge)).toEqual(["restart"]);
    });

    it("does not take the restart's yes for a yes to the rest of the command", async () => {
        commandAnswer = { refusal: "Refused: deletes files recursively." };
        expect(await through("run_command", { command: "ic sandbox restart work; rm -rf ~/old-builds" })).toEqual({
            refusal: "Refused: deletes files recursively.",
        });
        expect(asked.map((entry) => entry.judge)).toEqual(["restart", "command"]);
    });

    it("is read from every door that carries a program: app_start with arguments, typed text, an open of a spaced target", async () => {
        await through("app_start", { program: "powershell", args: ["-c", "ic sandbox update work"] });
        await through("device", { action: "type", text: "ic sandbox rebuild work 3f2a\n" });
        await through("open", { target: "docker restart intentic-sandbox-work" });
        expect(asked.filter((entry) => entry.judge === "restart").map((entry) => entry.what)).toMatchObject([
            { call: { tool: "app_start", op: "update" } },
            { call: { tool: "device", op: "rebuild" } },
            { call: { tool: "open", op: "restart" } },
        ]);
    });

    it("leaves another sandbox, a phone's shell and a start to the command judge alone", async () => {
        await through("run_command", { command: "ic sandbox restart other" });
        await through("run_command", { command: "ic sandbox start work" });
        await through("android_shell", { command: "ic sandbox restart work" });
        expect(asked.map((entry) => entry.judge)).toEqual(["command", "command", "command"]);
    });
});

describe("a program started by another door than run_command", () => {
    it("is put to the command judge as the command it amounts to, with how it was carried", async () => {
        commandAnswer = { refusal: "Refused." };
        expect(await through("app_start", { program: "powershell", args: ["-c", "Remove-Item -Recurse $HOME"] })).toEqual({ refusal: "Refused." });
        expect(await through("app_start", { program: "notepad" })).toEqual({ refusal: "Refused." });
        expect(await through("open", { target: "https://example.com" })).toEqual({ refusal: "Refused." });
        expect(await through("android_shell", { serial: "R58M12", command: "pm list packages" })).toEqual({ refusal: "Refused." });
        expect(asked).toEqual([
            {
                judge: "command",
                what: { machine: MACHINE, command: "powershell -c 'Remove-Item -Recurse $HOME'", kind: "command", conversationId: CONVERSATION },
            },
            { judge: "command", what: { machine: MACHINE, command: "notepad", kind: "app-launch", conversationId: CONVERSATION } },
            { judge: "command", what: { machine: MACHINE, command: "https://example.com", kind: "app-launch", conversationId: CONVERSATION } },
            { judge: "command", what: { machine: MACHINE, command: "adb -s R58M12 shell pm list packages", kind: "phone-command", conversationId: CONVERSATION } },
        ]);
    });
});
