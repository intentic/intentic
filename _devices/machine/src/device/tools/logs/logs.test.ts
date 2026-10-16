import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../../policy.js";
import { type DeviceLog, deviceLogs, filterLines, icLogDir, listingText } from "./logs.js";

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "off",
    screen: "off",
    control: "off",
    sandboxes: "off",
    destructive: "off",
    programs: "off",
    ...overrides,
});

test("ic's log folder is found where ic itself writes it: INTENTIC_LOG_DIR first, else ~/.intentic/logs", () => {
    expect(icLogDir({ INTENTIC_LOG_DIR: "/srv/ic-logs" }, "/home/me")).toBe("/srv/ic-logs");
    expect(icLogDir({ INTENTIC_LOG_DIR: "" }, "/home/me")).toMatch(/[/\\]home[/\\]me[/\\]\.intentic[/\\]logs$/);
    expect(icLogDir({}, "/home/me")).toMatch(/\.intentic[/\\]logs$/);
});

test("the listing names every record with its size and time, ic's newest first and capped, and says what each kind holds", () => {
    const at = Date.parse("2026-10-11T08:00:00Z");
    const logs: DeviceLog[] = [
        { name: "machine.log", path: "/m/machine.log", kind: "agent", size: 2 * 1024 * 1024, mtimeMs: at },
        { name: "audit.jsonl", path: "/m/audit.jsonl", kind: "audit", size: 900, mtimeMs: at },
        ...Array.from({ length: 45 }, (_, index) => ({
            name: `ic/recreate-dev-${index}.log`,
            path: `/l/recreate-dev-${index}.log`,
            kind: "ic" as const,
            size: 4096,
            mtimeMs: at - index,
        })),
    ];
    const text = listingText(logs, "/l");
    expect(text).toContain("machine.log  2.0 MB  modified 2026-10-11T08:00:00.000Z");
    expect(text).toContain("audit.jsonl  900 B");
    expect(text).toContain("ic/recreate-dev-0.log  4 KB");
    expect(text).toContain("…and 5 older");
    expect(text).not.toContain("recreate-dev-44.log");
    expect(text).toContain("audit: every tool call");
    expect(text).toContain("ic: one ic run");
});

test("a read answers the last lines that pass the grep, and an audit read can keep one tool's failures only", () => {
    const lines = ["[t] keeper sandbox-1: healthy", "[t] watchdog: suspected sleep/resume", "[t] keeper sandbox-1: Restarting the sandbox"];
    expect(filterLines(lines, "agent", { lines: 1, grep: "KEEPER" })).toEqual(["[t] keeper sandbox-1: Restarting the sandbox"]);
    expect(filterLines(lines, "agent", { lines: 10 })).toEqual(lines);
    const audit = [
        JSON.stringify({ at: "a", tool: "run_command", ok: true, detail: "{}" }),
        JSON.stringify({ at: "b", tool: "read_file", ok: false, detail: "refused: outside" }),
        JSON.stringify({ at: "c", tool: "run_command", ok: false, detail: "failed: boom" }),
        "{torn",
    ];
    // SAFETY: every line the filter keeps is one of the JSON lines above, each with an `at`.
    expect(filterLines(audit, "audit", { lines: 10, failedOnly: true }).map((line) => (JSON.parse(line) as { at: string }).at)).toEqual(["b", "c"]);
    expect(filterLines(audit, "audit", { lines: 10, tool: "run_command", failedOnly: true })).toEqual(audit.slice(2, 3));
    // Unfiltered, the audit is read as it is, torn line and all.
    expect(filterLines(audit, "audit", { lines: 10 })).toHaveLength(4);
    expect(() => filterLines(lines, "agent", { lines: 1, grep: "(" })).toThrow("grep is not a usable pattern");
});

test("reading this device's records takes the same switches as a sandbox's log", async () => {
    await expect(deviceLogs(undefined, { lines: 10 }, scopes({ shell: "off", sandboxes: "off" }))).rejects.toBeInstanceOf(ScopeError);
});
