import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { boundExitId } from "./browser-exit.js";
import { profileOwner } from "./session-store.js";

// Exit belongs to whoever owns the Chromium profile, never to an account inside somebody else's: an identity's accounts
// share one profile, so two exits for two accounts in it would have one signed-in session appear from two countries at
// once.

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
    // Account names one exit, its identity names another; profileOwner resolves to the identity, not the account.
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
    // Checks the account's own id directly, which profileOwner never returns for it anyway; stated both ways.
    const capabilities = [identity("work"), account("reddit-work", { identity: "work", exit: "berlin" })];
    expect(boundExitId(capabilities, "reddit-work")).toBeUndefined();
});

test("a kind that owns no browser profile is never bound", () => {
    const capabilities = [{ id: "berlin", kind: "exit", config: { provider: "tor", autoStart: "off" } } as Capability];
    expect(boundExitId(capabilities, "berlin")).toBeUndefined();
});
