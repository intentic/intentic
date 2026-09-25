import { mergeHeavyRules } from "@intentic/constants/heavy-rules";
import { priorityOf } from "../../workload/workload-class.js";
import { heavyEnvPrefix } from "./heavy-commands.js";

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
