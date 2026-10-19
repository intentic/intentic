import { WORKSPACE_ROOT } from "@intentic/constants";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedProcesses, type ProcessRunner, type ProcessSpec } from "./managed-processes.js";

// Records launches the way tmux would run them; a session absent from the map is destroyed.
const fakeRunner = () => {
    const launches: { session: string; spec: ProcessSpec & { port: number } }[] = [];
    const cmd = new Map<string, string>();
    const runner: ProcessRunner = {
        launch: async (session, spec) => {
            launches.push({ session, spec });
            cmd.set(session, "node");
        },
        kill: (session) => {
            cmd.delete(session);
        },
        states: async () => new Map(cmd),
    };
    return { runner, launches };
};

const SPEC: ProcessSpec = { command: "pnpm dev", cwd: join(WORKSPACE_ROOT, "app", "operator") };

// A panel the person started from the sidebar used to go dark on every restart: the boot sweep killed its session and
// only `current` (memory) knew it had been running. The ledger in /history brings it back until the person stops it.
describe("user-started panels across a restart", () => {
    const histories: string[] = [];
    const history = (): string => {
        const dir = mkdtempSync(join(tmpdir(), "panels-history-"));
        histories.push(dir);
        return dir;
    };
    afterEach(() => {
        for (const dir of histories.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    const CREDENTIALS = { INTENTIC_DAEMON: "http://127.0.0.1:1", INTENTIC_PANEL_TOKEN: "old-token" };

    test("restarts a durable panel with the daemon's fresh credentials, never writing them to disk", async () => {
        const historyRoot = history();
        const before = fakeRunner();
        const first = createManagedProcesses(before.runner, { historyRoot });
        await first.start("app", { ...SPEC, durable: true, env: CREDENTIALS });
        await first.start("install", { ...SPEC, oneShot: true });
        expect(readFileSync(join(historyRoot, "panels.json"), "utf8")).not.toContain("old-token");
        first.stopAll();

        // A new daemon: a new manager with nothing in memory, after the boot sweep killed every panel- session.
        const after = fakeRunner();
        const second = createManagedProcesses(after.runner, { historyRoot });
        await second.restore({ INTENTIC_DAEMON: "http://127.0.0.1:2", INTENTIC_PANEL_TOKEN: "new-token" });
        expect(after.launches.map((launch) => launch.session)).toEqual(["panel-app"]);
        expect(after.launches[0]?.spec).toMatchObject({ command: SPEC.command, cwd: SPEC.cwd, env: { INTENTIC_PANEL_TOKEN: "new-token" } });
        expect(second.running("app")).toBe(true);
        expect(second.portOf("app")).toBeGreaterThan(0);
        second.stopAll();
    });

    test("a panel the person stopped stays stopped after the restart", async () => {
        const historyRoot = history();
        const first = createManagedProcesses(fakeRunner().runner, { historyRoot });
        await first.start("app", { ...SPEC, durable: true, env: CREDENTIALS });
        await first.stop("app");
        const after = fakeRunner();
        await createManagedProcesses(after.runner, { historyRoot }).restore(CREDENTIALS);
        expect(after.launches).toEqual([]);
    });
});
