import { buildRouteMap, type CommandContext } from "@stricli/core";
import { answeringUi, buildCommand, machineUi } from "../cli-ui.js";
import { askFleet } from "./client.js";
import { readFleet } from "./fleet.js";
import { installFleet, uninstallFleet } from "./fleet-install.js";
import { serveFleet } from "./fleet-service.js";

/* `intentic-machine ci-fleet`: the self-hosted CI runners on this Linux computer (ci-fleet/). `install` and `uninstall`
   set the root service up and take it down, `serve` is what its unit runs, `status` is what the Pipelines view reads,
   and `janitor` runs one pass now (`--dry-run` says what it would remove). */

const ASK_MS = 15 * 60_000;

interface InstallFlags {
    readonly user: string;
    readonly prune?: boolean;
    readonly slotsUsable?: number;
    readonly binary?: string;
}

const install = buildCommand<InstallFlags>({
    docs: { brief: "Set up the root service that keeps this computer's CI runners, their caches and the test-memory pool (run with sudo)" },
    parameters: {
        flags: {
            user: { kind: "parsed", parse: String, brief: "The account this computer's intentic agent runs as: it may ask the service" },
            prune: { kind: "boolean", optional: true, brief: "Also prune Docker's images, build cache and volumes here (a computer whose Docker is its own)" },
            slotsUsable: { kind: "parsed", parse: Number, optional: true, brief: "How many of the 16 test-memory slots CI may use on this computer" },
            binary: { kind: "parsed", parse: String, optional: true, brief: "Install this binary instead of the agent's release (an agent built from source)" },
        },
    },
    async func(this: CommandContext, flags: InstallFlags) {
        const ui = machineUi(this.process);
        ui.act("Setting up the CI fleet service");
        await installFleet({ user: flags.user, prune: flags.prune, slotsUsable: flags.slotsUsable, binary: flags.binary }, ui.note);
        ui.done("The CI fleet service runs: `intentic-machine ci-fleet status` shows the runners and its passes.");
    },
});

const uninstall = buildCommand({
    docs: { brief: "Take the CI fleet service down (run with sudo); the runners run on" },
    parameters: {},
    async func(this: CommandContext) {
        const ui = machineUi(this.process);
        ui.act("Taking the CI fleet service down");
        await uninstallFleet(ui.note);
        ui.done("The CI fleet service is gone.");
    },
});

const serve = buildCommand({
    docs: { brief: "Run the CI fleet service in this process (what its systemd unit runs)" },
    parameters: {},
    async func(this: CommandContext) {
        // allow(terminal-output): the service's own log stream, which the journal keeps
        await serveFleet((line) => void this.process.stdout.write(`${line}\n`));
    },
});

interface JsonFlags {
    readonly json: boolean;
}

const status = buildCommand<JsonFlags>({
    docs: { brief: "The CI runners on this computer and what the fleet service last did" },
    parameters: { flags: { json: { kind: "boolean", brief: "Print one JSON object, as the Pipelines view reads it", default: false } } },
    async func(this: CommandContext, flags: JsonFlags) {
        const fleet = await readFleet();
        if (flags.json) {
            // allow(terminal-output): the --json document, CiFleetSchema's shape
            this.process.stdout.write(`${JSON.stringify(fleet)}\n`);
            return;
        }
        const ui = answeringUi(this.process, false);
        ui.report("intentic · CI fleet", fleet.service.running ? `service v${fleet.service.version ?? "?"}` : (fleet.service.problem ?? "the fleet service is not installed"));
        ui.items(
            fleet.runners.map((runner) => ({
                tone: runner.state === "active" ? ("ok" as const) : runner.held === undefined ? ("fail" as const) : ("skip" as const),
                name: runner.name,
                meta: [runner.busy ? `busy${runner.job === undefined ? "" : `: ${runner.job}`}` : runner.state, runner.held === undefined ? "" : `held (${runner.held})`]
                    .filter((part) => part !== "")
                    .join(", "),
            })),
        );
    },
});

interface JanitorFlags {
    readonly dryRun: boolean;
}

const janitor = buildCommand<JanitorFlags>({
    docs: { brief: "Run one janitor pass now through the fleet service" },
    parameters: { flags: { dryRun: { kind: "boolean", brief: "Say what it would remove and remove nothing", default: false } } },
    async func(this: CommandContext, flags: JanitorFlags) {
        const answer = await askFleet({ verb: "janitor", dryRun: flags.dryRun }, ASK_MS);
        // allow(terminal-output): the pass's own lines, as the journal would hold them
        this.process.stdout.write(`${(answer.pass?.lines ?? []).join("\n")}\n`);
    },
});

export const ciFleetRoutes = buildRouteMap({
    routes: { install, uninstall, serve, status, janitor },
    docs: { brief: "The self-hosted CI runners on this Linux computer, kept by a root service", hideRoute: { serve: true } },
});
