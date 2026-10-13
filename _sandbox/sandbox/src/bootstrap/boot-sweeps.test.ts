import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Logger } from "pino";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { HOUR_MS } from "../system/chore-clock.js";
import type { ContainerRole } from "../system/boot/container-owner.js";
import { retentionChores } from "./boot-chores.js";
import type { BootPhase } from "./boot-phase.js";
import { idleSweepLog } from "./boot-sweeps.js";

const recording = () => {
    const lines: { level: string; data: Record<string, unknown>; message: string }[] = [];
    const at = (level: string) => (data: Record<string, unknown>, message: string) => void lines.push({ level, data, message });
    return { lines, logger: { debug: at("debug"), info: at("info"), warn: at("warn") } as never };
};

const errno = (code: string): Error => Object.assign(new Error(`${code}: something`), { code });

test("a server that left mid-sweep is not a failure of the sweep", () => {
    const { lines, logger } = recording();
    const log = idleSweepLog(logger, () => 0);
    log.failed(errno("ESRCH"));
    log.succeeded();
    expect(lines.map((line) => line.level)).toEqual(["debug"]);
});

// The sweep runs every minute: a failure it keeps meeting used to be a stack every minute.
test("a failure every pass is one line, then the count hourly, then one line when a pass goes through", () => {
    const { lines, logger } = recording();
    const clock = { at: 0 };
    const log = idleSweepLog(logger, () => clock.at);
    for (let pass = 0; pass <= 60; pass += 1) {
        log.failed(errno("EACCES"));
        clock.at += 60_000;
    }
    log.succeeded();
    expect(lines.map((line) => [line.level, line.message])).toEqual([
        ["warn", "localmodel idle sweep failed"],
        ["warn", "localmodel idle sweep failed"],
        ["info", "localmodel idle sweep works again"],
    ]);
    expect(lines[1]?.data).toMatchObject({ repeated: 59 });
    expect(lines[2]?.data).toMatchObject({ after: "EACCES", repeated: 0 });
});

// The passes that run hourly or slower are chores on the persistent clock (system/chore-clock.ts), not timers of their own:
// each is scoped by the role this daemon claimed over the container, and each waits out its hour across restarts.

const phaseOf = (role: Pick<ContainerRole, "roots" | "container">, retentionDays = 30): BootPhase =>
    unstubbed<BootPhase>("phase", {
        config: unstubbed<Config>("config", { historyRoot: "/nowhere/history" }),
        logger: unstubbed<Logger>("logger", {}),
        role: unstubbed<ContainerRole>("role", role),
        services: unstubbed<Services>("services", {
            sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ ...SandboxSettingsSchema.parse({}), agentRetentionDays: retentionDays }) }),
            agents: unstubbed<Services["agents"]>("agents", { list: () => [] }),
            workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nowhere/workspace" }),
        }),
    });

const cadenceOf = (phase: BootPhase): readonly (readonly [string, number])[] => retentionChores(phase).map((chore) => [chore.name, chore.everyMs]);

test("the retention passes are hourly chores, scoped by role", () => {
    const hourly = (name: string): readonly [string, number] => [name, HOUR_MS];
    // settings.retention's sweeps (retention/retention-sweep.ts): hourly, restore points daily, and a five-minute look
    // for a changed setting. Root-scoped like the rest: they delete what the root's history holds.
    const dataRetention = [hourly("data-retention"), ["data-retention-restore-points", 24 * HOUR_MS] as const, ["data-retention-settings", 5 * 60_000] as const];
    expect(cadenceOf(phaseOf({ roots: true, container: true }))).toEqual([
        ...dataRetention,
        hourly("agents-aged-archive"),
        hourly("state-aged"),
        hourly("log-retention"),
        hourly("finished-terminal-sessions"),
    ]);
    // A guest sharing the history root prunes nothing of the root's.
    expect(cadenceOf(phaseOf({ roots: false, container: true }))).toEqual([hourly("finished-terminal-sessions")]);
    expect(cadenceOf(phaseOf({ roots: true, container: false }))).toEqual([
        ...dataRetention,
        hourly("agents-aged-archive"),
        hourly("state-aged"),
        hourly("log-retention"),
    ]);
    expect(cadenceOf(phaseOf({ roots: false, container: false }))).toEqual([]);
});

test("the aged-agent archive reads the retention setting as it is when it runs, and 0 days archives nothing", async () => {
    const archive = retentionChores(phaseOf({ roots: true, container: false }, 0)).find((chore) => chore.name === "agents-aged-archive");
    // Nothing is listed for archiving when the window is off, so a chore that tried to would name what it reached for.
    await expect(archive?.run()).resolves.toBeUndefined();
});
