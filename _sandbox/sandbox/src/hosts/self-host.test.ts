import { type Device, DeviceSandboxSchema, hostRunningSandbox } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// The predicate behind every "run it out there instead of asking" path, tested beside the daemon's reader of it
// (self-host.ts). The browser reads the same function through useHostRunning, so a button and a turn cannot disagree
// about which machine is reachable. It lives in the contract; the directory holding it is at its layout cap.

// Defaults from the schema itself, so a field added to a container row doesn't quietly make these unrepresentative.
const holding = (slugs: readonly string[]): Device["sandboxes"] =>
    slugs.map((slug) =>
        DeviceSandboxSchema.parse({ slug, container: `intentic-sandbox-${slug}`, running: true, image: "ghcr.io/intentic/sandbox:2.3.1" }),
    );

const device = (over: Partial<Device> = {}): Device => ({ key: "ada-laptop", label: "ada-laptop", ...over });

test("names the connected device whose docker reports this sandbox", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, sandboxes: holding(["work-abc", "other"]) })];
    expect(hostRunningSandbox(devices, "work-abc")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "other")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "not-here")).toBeUndefined();
});

// The card setup writes for a new sandbox: it may manage this machine's sandboxes and nothing else, so the machine
// lists its containers and refuses to describe itself. Judging it on the report is what printed a terminal command
// for the one rebuild a fresh sandbox always needs.
test("names a machine that listed its containers while refusing to describe itself", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, gap: "scope-off", sandboxes: holding(["work-abc"]) })];
    expect(hostRunningSandbox(devices, "work-abc")).toBe("ada-laptop");
});

// Each of these is a machine we cannot send a command to, and each looks like a working device in every other way.
test("stays silent for a device that cannot be sent a command", () => {
    const running = holding(["work-abc"]);
    // Enrolled for desktop sync only: it volunteers a report but holds no socket, so there is no `hostId` to call.
    expect(hostRunningSandbox([device({ sandboxes: running, sync: { machine: "ada-laptop", mode: "sync" } })], "work-abc")).toBeUndefined();
    // Connected, asleep.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: false, sandboxes: running })], "work-abc")).toBeUndefined();
    // Connected and up, and its docker really holds nothing.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, sandboxes: [] })], "work-abc")).toBeUndefined();
    // Connected and up, but its docker was never read: no `sandboxes` permission, no docker, or nothing asked yet.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true })], "work-abc")).toBeUndefined();
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, gap: "offline" })], "work-abc")).toBeUndefined();
});

// A caller with no slug must get no answer rather than the first plausible machine: the empty string is what a
// container name with nothing after its prefix leaves behind.
test("refuses to guess a machine for a sandbox it cannot name", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, sandboxes: holding(["work-abc"]) })];
    expect(hostRunningSandbox(devices, undefined)).toBeUndefined();
    expect(hostRunningSandbox(devices, "")).toBeUndefined();
});
