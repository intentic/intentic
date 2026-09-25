import { join } from "node:path";
import { parseArgs } from "node:util";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { statePath } from "./state-paths.js";
import { recordNewestRun } from "./store/newest-run.js";
import { planState } from "./store/state-convergence.js";
import { version } from "./version.js";

// The update pre-flight: run inside the TARGET image over read-only mounts of the running sandbox's volumes
// (`node /opt/sandbox/dist/state-plan.js --workspace /work --history /history`), it prints what that image's boot step
// would convert, and which conversions would fail, before the host swaps anything. One JSON line on stdout; the host's
// reader (`ic`, _sandbox/ic/src/sandbox/preflight.rs) refuses an update only on an explicit `"ok": false`.

const { values } = parseArgs({
    options: {
        workspace: { type: "string", default: WORKSPACE_ROOT },
        history: { type: "string", default: HISTORY_ROOT },
        // Where AI-provider homes live when AGENT_AUTH_DIR moved them off the workspace.
        auth: { type: "string" },
    },
});

const workspace = values.workspace;
const roots = {
    workspace,
    history: values.history,
    auth: values.auth ?? statePath(workspace, ".intentic/secrets/auth/"),
};

// Evaluated for what it registers: every stored document and structural step this build knows, exactly the registry the
// daemon's own boot step converges with. Loading it opens nothing and writes nothing.
await import("./composition.js");
// Learns the stamp (so a downgrade is named) without writing it: the mounts are read-only and this is not the daemon.
await recordNewestRun(workspace, version, { write: false });
const plan = await planState({ roots });

process.stdout.write(
    `${JSON.stringify({
        plan: 1,
        version,
        engine: plan.engine,
        ok: plan.failures.length === 0,
        downgrade: plan.downgrade,
        failures: plan.failures,
        steps: plan.steps,
        files: [...plan.writes.keys()].map((path) => (path.startsWith(join(workspace, "/")) ? path.slice(workspace.length + 1) : path)),
    })}\n`,
);
// The composition import leaves timers and handles behind that are not this entry's to wait for.
process.exit(0);
