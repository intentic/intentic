import { describe, expect, test } from "vitest";
import type { AdmissionPolicy } from "@intentic/sandbox-contract";
import { childSpawn, commandRun, outboundSend, sessionStart, wakeSourceOf } from "./actions.js";
import { defineGuardedAction, guard, type GuardedAction, HOLD, isGuardedAction, listGuardedActions } from "./guard.js";

// Spelled out rather than built from the schema's defaults on purpose: `issues` defaults to "hold", and a
// fixture that inherited that would be testing the policy instead of the mechanism.
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

    // The conformance floor: the catalog names every decision the daemon consults, so a consult site that
    // invents its own gate instead of defining an action here is discoverable by its absence.
    test("the catalog carries the shipped actions", () => {
        const actions = listGuardedActions();
        for (const expected of ["session.start", "outbound.send", "command.run"]) {
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
        // Even alongside a countdown the automation asked for: deny wins.
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
    test("an unlisted class is allowed: the rulebook names what to stop", () => {
        expect(guard(commandRun, { commandClass: "git.destructive", rules: {} }).effect).toBe("allow");
        expect(guard(commandRun, { commandClass: "git.destructive", rules: { "package.publish": "deny" } }).effect).toBe("allow");
    });

    test("hold and deny come back as themselves: the gate decides how to say them", () => {
        expect(guard(commandRun, { commandClass: "files.destructive", rules: { "files.destructive": "hold" } }).effect).toBe("hold");
        expect(guard(commandRun, { commandClass: "files.destructive", rules: { "files.destructive": "deny" } }).effect).toBe("deny");
    });

    // A hold here is a real ask, so it must never carry the countdown that would turn it into "unless I'm slow".
    test("a hold carries no auto-run window", () => {
        const verdict = guard(commandRun, { commandClass: "secrets.access", rules: { "secrets.access": "hold" } });
        expect(verdict).not.toHaveProperty("autoRunAfterS");
    });

    test("the reason says what the command would do, not which settings key matched", () => {
        expect(guard(commandRun, { commandClass: "network.outbound", rules: { "network.outbound": "deny" } }).reason).toContain(
            "send a request out to the internet",
        );
    });

    /* THE STANDING FLOOR: held where the owner wrote nothing, on every turn, tainted or not. It is what makes a
     * fresh sandbox, whose rulebook is empty by default, not one mistyped path away from a formatted disk. */
    describe("the standing floor under the classes nothing undoes", () => {
        test("holds a disk or volume wipe on an ordinary turn with an empty rulebook", () => {
            const verdict = guard(commandRun, { commandClass: "system.destructive", rules: {} });
            expect(verdict.effect).toBe("hold");
            expect(verdict.reason).toContain("nothing here undoes");
        });

        // Narrow on purpose. A floor that fires on ordinary work is one people learn to click through, so
        // everything recoverable stays allowed on an empty rulebook exactly as it always was.
        test("nothing else is held on an empty rulebook", () => {
            for (const commandClass of ["git.destructive", "files.destructive", "secrets.access", "package.publish", "network.outbound"] as const) {
                expect(guard(commandRun, { commandClass, rules: {} }).effect, commandClass).toBe("allow");
            }
        });

        // The floor is a default, not an override: an owner who said `allow` about this exact class decided it.
        test("the owner's explicit rule wins both ways", () => {
            expect(guard(commandRun, { commandClass: "system.destructive", rules: { "system.destructive": "allow" } }).effect).toBe("allow");
            expect(guard(commandRun, { commandClass: "system.destructive", rules: { "system.destructive": "deny" } }).effect).toBe("deny");
        });
    });

    /* The taint floor: the other verdict here the owner did not write. It holds credential reads AND recursive
     * deletes on a turn that has taken in somebody else's words, and it yields to any rule they DID write. */
    describe("the outside-content floor", () => {
        test("holds a credential read on a tainted turn, and names the source in the reason", () => {
            const verdict = guard(commandRun, { commandClass: "secrets.access", rules: {}, outsideSource: "discord" });
            expect(verdict.effect).toBe("hold");
            expect(verdict.reason).toContain("discord");
        });

        /* `rm -rf node_modules` is ordinary work and stays unasked all day; the same command in a turn that has
         * just read a stranger's bug report is the injection everybody pictures, and one card is a cheap way to
         * not find out afterwards which of the two it was. */
        test("holds a recursive delete on a tainted turn too", () => {
            const verdict = guard(commandRun, { commandClass: "files.destructive", rules: {}, outsideSource: "webchat" });
            expect(verdict.effect).toBe("hold");
            expect(verdict.reason).toContain("webchat");
        });

        test("an untainted turn is untouched", () => {
            expect(guard(commandRun, { commandClass: "secrets.access", rules: {} }).effect).toBe("allow");
            expect(guard(commandRun, { commandClass: "files.destructive", rules: {} }).effect).toBe("allow");
        });

        test("the rest of the catalog is untouched: a tainted turn still pushes and publishes as configured", () => {
            for (const commandClass of ["git.destructive", "package.publish", "network.outbound"] as const) {
                expect(guard(commandRun, { commandClass, rules: {}, outsideSource: "web" }).effect, commandClass).toBe("allow");
            }
        });

        test("the owner's own rule wins both ways: the floor applies only where they said nothing", () => {
            expect(guard(commandRun, { commandClass: "secrets.access", rules: { "secrets.access": "allow" }, outsideSource: "web" }).effect).toBe(
                "allow",
            );
            expect(guard(commandRun, { commandClass: "secrets.access", rules: { "secrets.access": "deny" }, outsideSource: "web" }).effect).toBe(
                "deny",
            );
        });

        // A hold is a real ask here too, so it must not carry the countdown that turns it into "unless I'm slow".
        test("the floor's hold carries no auto-run window", () => {
            const verdict = guard(commandRun, { commandClass: "secrets.access", rules: {}, outsideSource: "web" });
            expect(verdict).not.toHaveProperty("autoRunAfterS");
        });
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

/* The child-agent rule: the owner's own verdicts by provider or for the whole surface, and the taint floor
 * underneath — applied only where the owner said nothing, because an explicit allow is a decision about this
 * workspace. */
describe("agents.spawn", () => {
    test("allows by default and honours deny/hold, most specific key first", () => {
        expect(guard(childSpawn, { provider: "cursor", rules: {} }).effect).toBe("allow");
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "deny" } }).effect).toBe("deny");
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "hold" } }).effect).toBe("hold");
        // The per-provider key outranks the blanket one, the outbound gate's own precedence.
        expect(guard(childSpawn, { provider: "cursor", rules: { "agents.spawn": "deny", "agents.spawn.cursor": "allow" } }).effect).toBe("allow");
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "deny", "agents.spawn.cursor": "allow" } }).effect).toBe("deny");
    });

    test("holds a tainted parent's spawn unless the owner explicitly allowed it", () => {
        const held = guard(childSpawn, { provider: "claude", rules: {}, outsideSource: "webchat" });
        expect(held.effect).toBe("hold");
        expect(held.reason).toContain("webchat");
        // An explicit allow is the owner's decision about this exact surface; the floor must not override it.
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "allow" }, outsideSource: "webchat" }).effect).toBe("allow");
        // An explicit deny still outranks everything.
        expect(guard(childSpawn, { provider: "claude", rules: { "agents.spawn": "deny" }, outsideSource: "webchat" }).effect).toBe("deny");
    });
});
