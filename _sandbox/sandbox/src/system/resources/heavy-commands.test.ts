import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { priorityOf } from "../../workload/workload-class.js";
import { existsSync } from "node:fs";
import { HEAVY_SHIMS_DIR, heavyEnvPrefix, heavyEnvVariables } from "./heavy-commands.js";

// What a line the daemon runs carries down so each program it starts is judged as it starts: the table, the class a
// heavy one takes, and where it queues or goes. The judging itself is @intentic/constants heavy-rules.cjs and
// heavy-hook.cjs, and their suites; this pins only the handover.

const tableOf = (prefix: string): Record<string, unknown> => {
    const quoted = /INTENTIC_HEAVY=('(?:[^']|'\\'')*')/u.exec(prefix)?.[1] ?? "''";
    return JSON.parse(quoted.slice(1, -1).replaceAll(`'\\''`, "'")) as Record<string, unknown>;
};

test("the prefix is an `env` command, so it may follow nice, choom or nsenter, and it keeps the caller's NODE_OPTIONS", () => {
    const prefix = heavyEnvPrefix(mergeHeavyRules(), { queueRun: "/usr/local/bin/queue-run" });
    expect(prefix.startsWith("env INTENTIC_HEAVY='")).toBe(true);
    expect(prefix).toMatch(/ NODE_OPTIONS="--require \S+heavy-hook\.cjs \$\{NODE_OPTIONS:-\}" /u);
});

test("the table carries the merged rules, the queue, and the toolchain class", () => {
    const table = tableOf(heavyEnvPrefix(mergeHeavyRules({ limit: 3 }), { queueRun: "/usr/local/bin/queue-run" }));
    expect(table).toEqual({
        rules: mergeHeavyRules({ limit: 3 }),
        queue: true,
        queueRun: "/usr/local/bin/queue-run",
        klass: priorityOf({ class: "toolchain" }),
    });
});

// Queueing and ranking are separate: where nothing queues, a build is still the first thing the OOM killer takes.
test("with no queue-run, or the queue switched off, programs are still classed and nothing queues", () => {
    expect(tableOf(heavyEnvPrefix(mergeHeavyRules(), { queueRun: undefined }))).toMatchObject({ queue: false, klass: priorityOf({ class: "toolchain" }) });
    expect(tableOf(heavyEnvPrefix(mergeHeavyRules({ queue: false }), { queueRun: "/usr/local/bin/queue-run" }))).toMatchObject({ queue: false });
});

test("the kinds sent to a runner travel only when offload-run is named with them", () => {
    const routes = { "package-script": "runner-omen" };
    expect(tableOf(heavyEnvPrefix(mergeHeavyRules(), { queueRun: undefined, offloadRun: "/usr/local/bin/offload-run", offload: routes }))).toMatchObject({
        offloadRun: "/usr/local/bin/offload-run",
        offload: routes,
    });
    expect(Object.keys(tableOf(heavyEnvPrefix(mergeHeavyRules(), { queueRun: undefined })))).not.toContain("offload");
});

test("a config value that looks like shell is data inside the quoted table", () => {
    const prefix = heavyEnvPrefix(mergeHeavyRules({ ruleEdits: [{ id: "x'; touch /tmp/pwned; '", pattern: "make", pool: "$(id)" }] }), { queueRun: undefined });
    expect((tableOf(prefix)["rules"] as { rules: { id: string; pool?: string }[] }).rules[0]).toMatchObject({ id: "x'; touch /tmp/pwned; '", pool: "$(id)" });
});

// A vendor runtime's shell gets the same judging as a Claude Code line, as variables set once for the turn: the one table,
// the hook ahead of whatever NODE_OPTIONS it had, and the wrappers ahead of its PATH.
test("the variables carry the same table as the prefix, and keep what the shell already had behind them", () => {
    const rules = mergeHeavyRules({ limit: 3 });
    const variables = heavyEnvVariables(rules, { queueRun: "/usr/local/bin/queue-run" }, { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(JSON.parse(variables["INTENTIC_HEAVY"] ?? "{}")).toEqual(tableOf(heavyEnvPrefix(rules, { queueRun: "/usr/local/bin/queue-run" })));
    expect(variables["NODE_OPTIONS"]).toMatch(/^--require \S+heavy-hook\.cjs --max-old-space-size=4096$/u);
    // State the mode: the wrappers exist only in the image, and without them PATH is the shell's own.
    if (existsSync(HEAVY_SHIMS_DIR)) {
        expect(variables["PATH"]).toBe(`${HEAVY_SHIMS_DIR}:/usr/bin:/bin`);
    } else {
        expect(variables["PATH"]).toBeUndefined();
    }
});

test("a shell with no NODE_OPTIONS of its own gets the hook alone", () => {
    expect(heavyEnvVariables(mergeHeavyRules(), { queueRun: undefined }, {})["NODE_OPTIONS"]).toMatch(/^--require \S+heavy-hook\.cjs$/u);
});
