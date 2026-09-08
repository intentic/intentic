import { describe, expect, test } from "vitest";
import { type AdmissionPolicy, COMMAND_CLASS_LABELS } from "@intentic/sandbox-contract";
import { childSpawn, commandRun, outboundSend, sessionStart, wakeSourceOf } from "./actions.js";
import { defineGuardedAction, guard, type GuardedAction, HOLD, isGuardedAction, listGuardedActions } from "./guard.js";

// Spelled out, not from schema defaults: `issues` defaults to hold, which would test policy, not mechanism.
const allowAll: AdmissionPolicy = {
    schedule: "allow",
    event: "allow",
    listener: "allow",
    webchat: "allow",
    issues: "allow",
    workspace: "allow",
    workflow: "allow",
};

describe("guard mechanism", () => {
    test("fails closed on a throwing decide", () => {
        const boom = defineGuardedAction<undefined>({
            action: "test.throwing",
            decide: () => {
                throw new Error("policy store unreadable");
            },
        });
        const verdict = guard(boom, undefined);
        expect(verdict.effect).toBe("deny");
        expect(verdict.reason).toContain("failing closed");
    });

    test("fails closed on a hand-rolled action object: only minted values pass", () => {
        const forged = { action: "test.forged", decide: () => HOLD("x") } as unknown as GuardedAction<undefined>;
        expect(isGuardedAction(forged)).toBe(false);
        expect(guard(forged, undefined).effect).toBe("deny");
    });

    test("defining the same action twice throws: names are the catalog key", () => {
        defineGuardedAction<undefined>({ action: "test.dup", decide: () => HOLD("x") });
        expect(() => defineGuardedAction<undefined>({ action: "test.dup", decide: () => HOLD("x") })).toThrow(/already defined/);
    });

    test("the catalog carries the shipped actions", () => {
        const actions = listGuardedActions();
        for (const expected of ["session.start", "outbound.send", "command.run", "credential.use"]) {
            expect(actions, `catalog is missing "${expected}"`).toContain(expected);
        }
    });
});

describe("session.start", () => {
    test("all-allow policy admits every source", () => {
        for (const source of ["schedule", "event", "listener", "webchat", "workspace", "workflow"] as const) {
            expect(guard(sessionStart, { source, admission: allowAll }).effect).toBe("allow");
        }
    });

    test("a floor deny refuses, and beats every weaker signal", () => {
        const admission = { ...allowAll, webchat: "deny" as const };
        const verdict = guard(sessionStart, { source: "webchat", admission, holdForSeconds: 60 });
        expect(verdict.effect).toBe("deny");
    });

    test("requireApproval holds with no auto-run, even when a countdown is also configured", () => {
        const verdict = guard(sessionStart, { source: "schedule", admission: allowAll, requireApproval: true, holdForSeconds: 30 });
        expect(verdict).toMatchObject({ effect: "hold" });
        expect(verdict).not.toHaveProperty("autoRunAfterS");
    });

    test("a floor hold is 'ask me': no auto-run countdown either", () => {
        const admission = { ...allowAll, listener: "hold" as const };
        const verdict = guard(sessionStart, { source: "listener", admission, holdForSeconds: 30 });
        expect(verdict).toMatchObject({ effect: "hold" });
        expect(verdict).not.toHaveProperty("autoRunAfterS");
    });

    test("a pure countdown hold carries its auto-run window", () => {
        const verdict = guard(sessionStart, { source: "schedule", admission: allowAll, holdForSeconds: 45 });
        expect(verdict).toMatchObject({ effect: "hold", autoRunAfterS: 45 });
    });
});

describe("outbound.send", () => {
    test("no rule allows", () => {
        expect(guard(outboundSend, { provider: "discord", type: "message.send", rules: {} }).effect).toBe("allow");
    });

    test("the exact key wins over the provider wildcard", () => {
        const rules = { "discord.*": "deny", "discord.message.send": "allow" } as const;
        expect(guard(outboundSend, { provider: "discord", type: "message.send", rules }).effect).toBe("allow");
        expect(guard(outboundSend, { provider: "discord", type: "reaction.add", rules }).effect).toBe("deny");
    });

    test("hold and deny come back as themselves: the gate decides how to say them", () => {
        const rules = { "slack.message.send": "hold", "slack.message.edit": "deny" } as const;
        expect(guard(outboundSend, { provider: "slack", type: "message.send", rules }).effect).toBe("hold");
        expect(guard(outboundSend, { provider: "slack", type: "message.edit", rules }).effect).toBe("deny");
    });
});

describe("command.run", () => {
    // Baseline live command context, sandbox locus, used by the hard-rule tests below.
    const ran = { locus: "sandbox", live: true } as const;

    test("the hard rule holds the classes where nothing recovers", () => {
        const verdict = guard(commandRun, { commandClass: "system.destructive", ...ran });
        expect(verdict.effect).toBe("hold");
        expect(verdict.reason).toContain("nothing here undoes");
    });

    // Narrow on purpose: widening the hard rule to any of these would recreate the old floor under a new name.
    test("everything else is left to the policy in the sandbox", () => {
        for (const commandClass of [
            "git.destructive",
            "files.destructive",
            "container.state",
            "secrets.access",
            "package.publish",
            "network.outbound",
        ] as const) {
            expect(guard(commandRun, { commandClass, ...ran }).effect, commandClass).toBe("allow");
        }
    });

    // A device isn't rebuilt from an image like this container, so the judge holds what the sandbox would allow.
    test("a device holds every class that destroys something", () => {
        for (const commandClass of ["files.destructive", "system.destructive", "container.state"] as const) {
            expect(guard(commandRun, { commandClass, locus: "device", live: true }).effect, commandClass).toBe("hold");
        }
    });

    test("a class the command only mentions is not held, at either locus", () => {
        for (const locus of ["sandbox", "device"] as const) {
            const verdict = guard(commandRun, { commandClass: "system.destructive", locus, live: false });
            expect(verdict.effect, locus).toBe("allow");
            expect(verdict.reason, locus).toContain("only mentions");
        }
    });

    test("the reason says what the command would do, not which class matched", () => {
        expect(guard(commandRun, { commandClass: "system.destructive", ...ran }).reason).toContain(COMMAND_CLASS_LABELS["system.destructive"]);
    });

    test("the hold carries no auto-run window", () => {
        expect(guard(commandRun, { commandClass: "system.destructive", ...ran })).not.toHaveProperty("autoRunAfterS");
    });
});

describe("wakeSourceOf", () => {
    test("maps each trigger to its admission key, splitting webchat off the listener family", () => {
        expect(wakeSourceOf({ kind: "schedule", cron: "0 9 * * *" })).toBe("schedule");
        expect(wakeSourceOf({ kind: "event" })).toBe("event");
        expect(wakeSourceOf({ kind: "listener", provider: "discord" })).toBe("listener");
        expect(wakeSourceOf({ kind: "listener", provider: "webchat" })).toBe("webchat");
        expect(wakeSourceOf({ kind: "workspace", event: "agent.landed" })).toBe("workspace");
    });
});

// Owner rules, per-provider or blanket, plus a taint floor that applies only when the owner set no rule.
describe("agents.spawn", () => {
    test("allows by default and honours deny/hold, most specific key first", () => {
        expect(guard(childSpawn, { provider: "cursor", rules: {} }).effect).toBe("allow");
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "deny" } }).effect).toBe("deny");
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "hold" } }).effect).toBe("hold");
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "deny", "agents.spawn.cursor": "allow" } }).effect).toBe("allow");
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "deny", "agents.spawn.cursor": "allow" } }).effect).toBe("deny");
    });

    test("holds a tainted parent's spawn unless the owner explicitly allowed it", () => {
        const held = guard(childSpawn, { provider: "claude", rules: {}, outsideSource: "webchat" });
        expect(held.effect).toBe("hold");
        expect(held.reason).toContain("webchat");
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "allow" }, outsideSource: "webchat" }).effect).toBe("allow");
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "deny" }, outsideSource: "webchat" }).effect).toBe("deny");
    });
});
