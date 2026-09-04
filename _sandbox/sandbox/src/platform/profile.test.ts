import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import { testConfig } from "../testing.js";
import { listenHost, localContractComplaints, profileTraits } from "./profile.js";

const withSandbox = (overrides: Partial<Config["sandbox"]>, rest: Partial<Config> = {}): Config => ({
    ...testConfig,
    ...rest,
    sandbox: { ...testConfig.sandbox, ...overrides },
});

test("container profile keeps every container trait on", () => {
    const traits = profileTraits(withSandbox({}));
    expect(Object.values(traits).every((trait) => trait === true)).toBe(true);
});

test("local profile switches every container trait off", () => {
    const traits = profileTraits(withSandbox({ profile: "local" }));
    expect(Object.values(traits).every((trait) => trait === false)).toBe(true);
});

test("listenHost keeps the configured host for the container profile", () => {
    expect(listenHost(withSandbox({ host: "0.0.0.0" }))).toBe("0.0.0.0");
});

// The schema default says "the operator chose nothing", which for a process on someone's own machine must
// mean loopback: the collapse is the local profile's safety default, not a preference.
test("listenHost collapses the container default onto loopback for the local profile", () => {
    expect(listenHost(withSandbox({ profile: "local", host: "0.0.0.0" }))).toBe("127.0.0.1");
    expect(listenHost(withSandbox({ profile: "local", host: "::1" }))).toBe("::1");
});

test("the local floor accepts a plain loopback config", () => {
    expect(localContractComplaints(withSandbox({ profile: "local" }))).toEqual([]);
});

test("the local floor never complains about the container profile", () => {
    expect(localContractComplaints(withSandbox({ publicUrl: "https://sandbox-x.example.dev" }, { connectToken: "ict_x" }))).toEqual([]);
});

// Each contradiction is named separately: the operator fixing one must not discover the next on the
// following restart.
test("the local floor refuses every env that contradicts a loopback-only daemon, all at once", () => {
    const complaints = localContractComplaints(
        withSandbox(
            { profile: "local", host: "192.168.1.10", publicUrl: "https://sandbox-x.example.dev" },
            { connectToken: "ict_x", platform: { url: "https://platform.example.dev", publicKey: "" } },
        ),
    );
    expect(complaints).toHaveLength(4);
    expect(complaints.join("\n")).toContain("SANDBOX_HOST");
    expect(complaints.join("\n")).toContain("CONNECT_TOKEN");
    expect(complaints.join("\n")).toContain("SANDBOX_PUBLIC_URL");
    expect(complaints.join("\n")).toContain("PLATFORM_URL");
});
