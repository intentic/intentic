import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable";
import { allowedBy, CANCELLED, personAnswer, pickOption, refusePermission, selectedOption } from "./answers.js";

const ONCE: PermissionOption = { optionId: "once", name: "Allow", kind: "allow_once" };
const ALWAYS: PermissionOption = { optionId: "always", name: "Always allow", kind: "allow_always" };
const NO: PermissionOption = { optionId: "no", name: "Reject", kind: "reject_once" };
const NEVER: PermissionOption = { optionId: "never", name: "Never", kind: "reject_always" };

const ask = (...options: PermissionOption[]): RequestPermissionRequest => ({ sessionId: "s", toolCall: { toolCallId: "t", title: "rm -rf build" }, options });

test("a pick takes the first kind on offer, in the order the kinds are named", () => {
    expect(pickOption([ONCE, ALWAYS, NO], ["allow_always", "allow_once"])).toBe(ALWAYS);
    expect(pickOption([ONCE, NO], ["allow_always", "allow_once"])).toBe(ONCE);
    expect(pickOption([NO], ["allow_always", "allow_once"])).toBeUndefined();
});

test("a person's decision is said as one of the options the agent offered", () => {
    expect(personAnswer(ask(ONCE, ALWAYS, NO), "once")).toEqual(selectedOption(ONCE));
    expect(personAnswer(ask(ONCE, ALWAYS, NO), "always")).toEqual(selectedOption(ALWAYS));
    expect(personAnswer(ask(ONCE, ALWAYS, NO, NEVER), "deny")).toEqual(selectedOption(NO));
    // A yes for good where only a one-time yes is on offer is that one time.
    expect(personAnswer(ask(ONCE, NO), "always")).toEqual(selectedOption(ONCE));
});

test("a no with no no on offer is a cancel, so the call never runs", () => {
    expect(personAnswer(ask(ONCE, ALWAYS), "deny")).toEqual(CANCELLED);
    expect(refusePermission(ask(ONCE, ALWAYS))).toEqual(CANCELLED);
    expect(refusePermission(ask(ONCE, NEVER))).toEqual(selectedOption(NEVER));
});

test("only a selected yes let the call run", () => {
    const request = ask(ONCE, ALWAYS, NO);
    expect(allowedBy(request, selectedOption(ONCE))).toBe(true);
    expect(allowedBy(request, selectedOption(ALWAYS))).toBe(true);
    expect(allowedBy(request, selectedOption(NO))).toBe(false);
    expect(allowedBy(request, CANCELLED)).toBe(false);
    // An option the agent never offered answers for nothing.
    expect(allowedBy(request, { outcome: { outcome: "selected", optionId: "made-up" } })).toBe(false);
});
