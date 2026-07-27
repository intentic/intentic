import { expect, test } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { decidePermission } from "./acp-permissions.js";

const request = (
    kind: string | undefined,
    options: { optionId: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[],
): RequestPermissionRequest => ({
    sessionId: "s1",
    toolCall: { toolCallId: "t1", ...(kind !== undefined ? { kind: kind as "edit" } : {}) },
    options: options.map((option) => ({ ...option, name: option.optionId })),
});

test("execute phase auto-allows, preferring allow_always", () => {
    const decided = decidePermission(
        request("execute", [
            { optionId: "once", kind: "allow_once" },
            { optionId: "always", kind: "allow_always" },
        ]),
        "execute",
        false,
    );
    expect(decided).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
});

test("plan phase rejects mutating tool kinds but allows reads", () => {
    const options: Parameters<typeof request>[1] = [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once" },
    ];
    expect(decidePermission(request("edit", options), "plan", false)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(decidePermission(request("read", options), "plan", false)).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
});

test("plan phase with no rejection offered falls through to allow (best-effort read-only)", () => {
    expect(decidePermission(request("execute", [{ optionId: "allow", kind: "allow_once" }]), "plan", false)).toEqual({
        outcome: { outcome: "selected", optionId: "allow" },
    });
});

test("an aborted turn answers cancelled; no options at all answers cancelled", () => {
    expect(decidePermission(request("execute", [{ optionId: "allow", kind: "allow_once" }]), "execute", true)).toEqual({
        outcome: { outcome: "cancelled" },
    });
    expect(decidePermission(request("execute", []), "execute", false)).toEqual({ outcome: { outcome: "cancelled" } });
});
