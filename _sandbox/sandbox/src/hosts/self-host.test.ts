import { type Device, DeviceReportSchema, hostRunningSandbox } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// The predicate behind every "run it out there instead of asking" path, tested beside the daemon's reader of it
// (self-host.ts). The browser reads the same function through useHostRunning, so a button and a turn cannot disagree
// about which machine is reachable. It lives in the contract; the directory holding it is at its layout cap.

// Defaults from the schema itself, so a field added to a report doesn't quietly make these rows unrepresentative.
const report = (slugs: readonly string[]): Device["report"] =>
    DeviceReportSchema.parse({
        hostname: "ada-laptop",
        os: "linux",
        sandboxes: slugs.map((slug) => ({ slug, container: `intentic-sandbox-${slug}`, running: true, image: "ghcr.io/intentic/sandbox:2.3.1" })),
        pairings: [],
        ports: [],
        agent: { running: true },
        capturedAt: 1_700_000_000_000,
    });

const device = (over: Partial<Device> = {}): Device => ({ key: "ada-laptop", label: "ada-laptop", ...over });

test("names the connected device whose docker reports this sandbox", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, report: report(["work-abc", "other"]) })];
    expect(hostRunningSandbox(devices, "work-abc")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "other")).toBe("ada-laptop");
    expect(hostRunningSandbox(devices, "not-here")).toBeUndefined();
});

// Each of these is a machine we cannot send a command to, and each looks like a working device in every other way.
test("stays silent for a device that cannot be sent a command", () => {
    const running = report(["work-abc"]);
    // Enrolled for desktop sync only: it volunteers a report but holds no socket, so there is no `hostId` to call.
    expect(hostRunningSandbox([device({ report: running, sync: { machine: "ada-laptop", mode: "sync" } })], "work-abc")).toBeUndefined();
    // Connected, asleep.
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: false, report: running })], "work-abc")).toBeUndefined();
    // Connected and up, but its docker was never read (no `sandboxes` permission, or no docker at all).
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, report: report([]) })], "work-abc")).toBeUndefined();
    expect(hostRunningSandbox([device({ hostId: "ada-laptop", online: true, gap: "offline" })], "work-abc")).toBeUndefined();
});

// A caller with no slug must get no answer rather than the first plausible machine: the empty string is what a
// container name with nothing after its prefix leaves behind.
test("refuses to guess a machine for a sandbox it cannot name", () => {
    const devices = [device({ hostId: "ada-laptop", online: true, report: report(["work-abc"]) })];
    expect(hostRunningSandbox(devices, undefined)).toBeUndefined();
    expect(hostRunningSandbox(devices, "")).toBeUndefined();
});
