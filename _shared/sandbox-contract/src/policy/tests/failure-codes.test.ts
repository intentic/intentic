import { AgentErrorCodeSchema } from "../../events/agent-events.js";
import { isPrivacyRefusal } from "../../schemas/privacy-egress.js";
import { FAILURE_CODES, failureCourseOf, failureTraitsOf,anotherModelClears,turnedAwayCode } from "../failure-codes.js";

// The codes whose row says `test`, sorted, so a pin reads as a list.
const codesWhere = (test: (code: string) => boolean): string[] => AgentErrorCodeSchema.options.filter(test).toSorted();

test("every code the wire names has a row, and the table names no code the wire does not", () => {
    expect(Object.keys(FAILURE_CODES).toSorted()).toEqual(AgentErrorCodeSchema.options.toSorted());
    for (const code of AgentErrorCodeSchema.options) {
        expect([code, failureTraitsOf(code)]).toEqual([code, FAILURE_CODES[code]]);
    }
});

// The door set as policy/turned-away.ts kept it by hand until the table: refused before the model saw a word.
test("the codes turned away at the door are exactly the eighteen refused before the model saw a word", () => {
    const door = codesWhere((code) => failureCourseOf(code) === "door");
    expect(door).toEqual(
        [
            "claude-reauth",
            "claude-not-entitled",
            "account-not-allowed",
            "unknown-command",
            "context-window-too-small",
            "model-helper-only",
            "privacy-unshielded",
            "tools-unenforced",
            "agent-domain-refused",
            "privacy-instructions",
            "sandbox-memory-low",
            "workspace-setup",
            "sandbox-disk-low",
            "trial-unavailable",
            "trial-model-unavailable",
            "trial-exhausted",
            "model-unavailable",
            "engine-version-floor",
        ].toSorted(),
    );
    expect(codesWhere(turnedAwayCode)).toEqual(door);
    expect(turnedAwayCode(undefined)).toBe(false);
});

test("another model clears exactly the refusals about the model, its trial or its account", () => {
    const cleared = [
        "claude-not-entitled",
        "account-not-allowed",
        "context-window-too-small",
        "model-helper-only",
        "trial-unavailable",
        "trial-model-unavailable",
        "trial-exhausted",
        "model-unavailable",
    ].toSorted();
    expect(codesWhere((code) => failureTraitsOf(code)?.anotherModelClears === true)).toEqual(cleared);
    expect(codesWhere(anotherModelClears)).toEqual(cleared);
    expect(anotherModelClears(undefined)).toBe(false);
});

test("every refusal the privacy shield names is the privacy kind, turned away at the door", () => {
    const privacy = codesWhere(isPrivacyRefusal);
    expect(privacy.length).toBeGreaterThan(0);
    for (const code of privacy) {
        expect([code, failureTraitsOf(code)?.kind, failureCourseOf(code)]).toEqual([code, "privacy", "door"]);
    }
    expect(codesWhere((code) => failureTraitsOf(code)?.kind === "privacy")).toEqual(privacy);
});

// The board's kinds as agentStatus-failure.ts kept them by hand until the table (KINDS_BY_CODE), the privacy shield's
// refusals added as it added them: pinned, so moving them here changed no word on a card.
test("every code keeps the kind the board named it by", () => {
    const pinned = {
        rate_limit: "limit",
        "session-not-found": "cutShort",
        "codex-advisory": "advisory",
        "unknown-command": "command",
        "agent-busy": "held",
        "sandbox-memory-low": "held",
        "sandbox-disk-low": "held",
        "tools-unenforced": "held",
        "agent-domain-refused": "held",
        "claude-not-entitled": "access",
        "account-not-entitled": "access",
        "account-not-allowed": "access",
        "subscription-required": "access",
        "claude-reauth": "signedOut",
        "codex-reauth": "signedOut",
        "claude-token-refused": "signedOut",
        "acp-auth-required": "signedOut",
        "provider-outage": "outage",
        "trial-unavailable": "outage",
        "grok-model-invalid": "model",
        "codex-model-invalid": "model",
        "model-unavailable": "model",
        "trial-model-unavailable": "model",
        "model-helper-only": "model",
        "context-window-too-small": "contextFull",
        "context-overflow": "contextFull",
        "engine-version-floor": "update",
        "safeguard-flagged": "flagged",
        "trial-exhausted": "limit",
        "workspace-setup": "held",
        "turn-cap": "cutShort",
        "harness-incomplete": "cutShort",
        "privacy-unshielded": "privacy",
        "privacy-instructions": "privacy",
    } as const;
    expect(Object.fromEntries(Object.entries(FAILURE_CODES).map(([code, traits]) => [code, traits.kind]))).toEqual(pinned);
});

test("each wall's own code takes its course, and a turn that stopped at its own ceiling is carried on by a press", () => {
    expect(failureCourseOf("rate_limit")).toBe("limit");
    expect(failureCourseOf("provider-outage")).toBe("outage");
    expect(failureCourseOf("claude-token-refused")).toBe("remint");
    expect(failureCourseOf("context-overflow")).toBe("overflow");
    expect(failureCourseOf("safeguard-flagged")).toBe("flagged");
    expect(failureCourseOf("codex-advisory")).toBe("note");
    expect(codesWhere((code) => failureCourseOf(code) === "carry")).toEqual(["harness-incomplete", "turn-cap"]);
    expect(codesWhere((code) => failureCourseOf(code) === "bare")).toEqual(
        [
            "session-not-found",
            "codex-reauth",
            "acp-auth-required",
            "account-not-entitled",
            "subscription-required",
            "grok-model-invalid",
            "codex-model-invalid",
            "agent-busy",
        ].toSorted(),
    );
});

test("a failure nothing coded is carried on, and a code this build does not know holds nothing", () => {
    expect(failureCourseOf(undefined)).toBe("carry");
    expect(failureTraitsOf(undefined)).toBeUndefined();
    expect(failureTraitsOf("a-newer-sandbox-code")).toBeUndefined();
    expect(failureCourseOf("a-newer-sandbox-code")).toBe("bare");
    // A plain record lookup would answer these with Object.prototype's own members.
    expect(failureTraitsOf("constructor")).toBeUndefined();
    expect(failureTraitsOf("toString")).toBeUndefined();
});
