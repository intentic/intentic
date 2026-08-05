import { describe, expect, test } from "vitest";
import type { AdmissionPolicy } from "@intentic/sandbox-contract";
import { outboundSend, sessionStart, wakeSourceOf } from "./actions.js";
import { defineGuardedAction, guard, type GuardedAction, HOLD, isGuardedAction, listGuardedActions } from "./guard.js";

const allowAll: AdmissionPolicy = { schedule: "allow", event: "allow", listener: "allow", webchat: "allow", workspace: "allow", workflow: "allow" };

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

    test("fails closed on a hand-rolled action object — only minted values pass", () => {
        const forged = { action: "test.forged", decide: () => HOLD("x") } as unknown as GuardedAction<undefined>;
        expect(isGuardedAction(forged)).toBe(false);
        expect(guard(forged, undefined).effect).toBe("deny");
    });

    test("defining the same action twice throws — names are the catalog key", () => {
        defineGuardedAction<undefined>({ action: "test.dup", decide: () => HOLD("x") });
        expect(() => defineGuardedAction<undefined>({ action: "test.dup", decide: () => HOLD("x") })).toThrow(/already defined/);
    });

    // The conformance floor: the catalog names every decision the daemon consults, so a consult site that
    // invents its own gate instead of defining an action here is discoverable by its absence.
    test("the catalog carries the shipped actions", () => {
        const actions = listGuardedActions();
        for (const expected of ["session.start", "outbound.send"]) {
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
        // Even alongside a countdown the automation asked for — deny wins.
        const verdict = guard(sessionStart, { source: "webchat", admission, holdForSeconds: 60 });
        expect(verdict.effect).toBe("deny");
    });

    test("requireApproval holds with no auto-run, even when a countdown is also configured", () => {
        const verdict = guard(sessionStart, { source: "schedule", admission: allowAll, requireApproval: true, holdForSeconds: 30 });
        expect(verdict).toMatchObject({ effect: "hold" });
        expect("autoRunAfterS" in verdict && verdict.autoRunAfterS).toBeFalsy();
    });

    test("a floor hold is 'ask me' — no auto-run countdown either", () => {
        const admission = { ...allowAll, listener: "hold" as const };
        const verdict = guard(sessionStart, { source: "listener", admission, holdForSeconds: 30 });
        expect(verdict).toMatchObject({ effect: "hold" });
        expect("autoRunAfterS" in verdict && verdict.autoRunAfterS).toBeFalsy();
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

    test("hold and deny come back as themselves — the gate decides how to say them", () => {
        const rules = { "slack.message.send": "hold", "slack.message.edit": "deny" } as const;
        expect(guard(outboundSend, { provider: "slack", type: "message.send", rules }).effect).toBe("hold");
        expect(guard(outboundSend, { provider: "slack", type: "message.edit", rules }).effect).toBe("deny");
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
