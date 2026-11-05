import type { DeviceReport, DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { type AnswerMemory, keepLastAnswer, LATE_KEEP_MS } from "../device-listing.js";

const report: DeviceReport = { hostname: "rog", os: "linux", pairings: [], ports: [], agent: { running: true, installed: "0.1.0" }, capturedAt: 0 };
const box: DeviceSandbox = { slug: "work", container: "intentic-sandbox-work", running: true, image: "img" };
const LATE = "no answer within 8 s";

// The memory a machine holds once it has answered both halves at `at`.
const answeredAt = (at: number): AnswerMemory => {
    const memory: AnswerMemory = {};
    keepLastAnswer(memory, { result: { report, sandboxes: [box] }, late: {} }, at);
    return memory;
};

test("a late listing reads as the containers the machine last listed, beside a report that answered", () => {
    const memory = answeredAt(0);
    expect(keepLastAnswer(memory, { result: { report }, late: { sandboxes: LATE } }, 30_000)).toEqual({ report, sandboxes: [box] });
});

test("a pull late on both halves reads as the machine's last answer, not as offline", () => {
    const memory = answeredAt(0);
    expect(keepLastAnswer(memory, { result: { gap: "offline" }, late: { report: LATE, sandboxes: LATE } }, 30_000)).toEqual({ report, sandboxes: [box] });
});

// The window is counted from the last real answer, not from the last reading served: lateness never renews it.
test("past the keep window a late machine reads as the gap it is", () => {
    const memory = answeredAt(0);
    const late = { result: { gap: "offline" as const }, late: { report: LATE, sandboxes: LATE } };
    expect(keepLastAnswer(memory, late, LATE_KEEP_MS - 1)).toEqual({ report, sandboxes: [box] });
    expect(keepLastAnswer(memory, late, LATE_KEEP_MS + 1)).toEqual({ gap: "offline" });
});

// A refusal is the machine's answer: a switch turned off withdraws the list at once, and lateness after it keeps nothing.
test("a refusal replaces the remembered answer, so a late reading after it brings nothing back", () => {
    const memory = answeredAt(0);
    const refused = { result: { report, sandboxesUnread: "sandboxes: off" }, late: {} };
    expect(keepLastAnswer(memory, refused, 30_000)).toEqual({ report, sandboxesUnread: "sandboxes: off" });
    expect(keepLastAnswer(memory, { result: { report }, late: { sandboxes: LATE } }, 60_000)).toEqual({ report });
});

test("a machine never answered is served what it said this time", () => {
    expect(keepLastAnswer({}, { result: { gap: "offline" }, late: { report: LATE, sandboxes: LATE } }, 0)).toEqual({ gap: "offline" });
});
