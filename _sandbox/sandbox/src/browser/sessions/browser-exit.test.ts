import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { boundExitId } from "./browser-exit.js";
import { profileOwner } from "./session-store.js";

/* WHICH BROWSER GOES WHERE. The rule under test is one sentence with a lot behind it: the exit belongs to
 * whatever owns the Chromium profile, never to an account living inside somebody else's.
 *
 * The reason is not tidiness. An identity's accounts share one profile, cookies and all, so if two of them
 * could name different exits, one signed-in Google session would appear from two countries at once. Sites do
 * not flag "datacenter address" anywhere near as hard as they flag a session that teleports, so the design
 * makes that unexpressible rather than merely discouraged.
 */

const identity = (id: string, exit?: string): Capability =>
    ({ id, kind: "identity", config: { email: `${id}@example.com`, openAccounts: "off", ...(exit === undefined ? {} : { exit }) } }) as Capability;
const account = (id: string, config: Record<string, string>): Capability =>
    ({ id, kind: "browser", config: { platform: "reddit", ...config } }) as Capability;

test("a standalone account is bound by its own field", () => {
    const capabilities = [account("reddit-solo", { exit: "berlin" })];
    expect(profileOwner(capabilities[0] as Capability)).toBe("reddit-solo");
    expect(boundExitId(capabilities, "reddit-solo")).toBe("berlin");
});

test("an identity's accounts are bound by the identity, not by themselves", () => {
    /* The account names an exit AND belongs to an identity that names another. profileOwner resolves the
     * account to the identity, so the identity's exit is the one that applies: the account's own field is not
     * consulted at all, which is what stops one shared profile straddling two countries. */
    const capabilities = [identity("work", "osaka"), account("reddit-work", { identity: "work", exit: "berlin" })];
    const owner = profileOwner(capabilities[1] as Capability);
    expect(owner).toBe("work");
    expect(boundExitId(capabilities, owner)).toBe("osaka");
});

test("an unbound profile resolves to nothing, and browses from the sandbox's own connection", () => {
    expect(boundExitId([account("plain", {})], "plain")).toBeUndefined();
    expect(boundExitId([identity("work")], "work")).toBeUndefined();
    // An id nobody added has no profile and therefore no exit.
    expect(boundExitId([], "ghost")).toBeUndefined();
});

test("an account's own exit field is inert while it belongs to an identity", () => {
    // Asked about the ACCOUNT's id directly (which profileOwner would never return for such an account), the
    // answer is still nothing: the invariant is stated in both directions rather than relied on from one side.
    const capabilities = [identity("work"), account("reddit-work", { identity: "work", exit: "berlin" })];
    expect(boundExitId(capabilities, "reddit-work")).toBeUndefined();
});

test("a kind that owns no browser profile is never bound", () => {
    const capabilities = [{ id: "berlin", kind: "exit", config: { provider: "tor", autoStart: "off" } } as Capability];
    expect(boundExitId(capabilities, "berlin")).toBeUndefined();
});
