import { join } from "node:path";
import { parseArgs } from "node:util";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { statePath } from "./state-paths.js";
import { recordNewestRun } from "./store/newest-run.js";
import { planState } from "./store/evolution/state-convergence.js";
import { stateDocuments, stateSteps } from "./store/evolution/state-registry.js";
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

// Learns the stamp (so a downgrade is named) without writing it: the mounts are read-only and this is not the daemon.
await recordNewestRun(workspace, version, { write: false });
// Every stored document and structural step this build knows, from the registry the daemon's own boot step converges
// with (bootstrap/state-boot.ts): the same list, not whatever this entry's imports happen to reach.
const plan = await planState({ roots, documents: stateDocuments(), steps: stateSteps(), version });

process.stdout.write(
    `${JSON.stringify({
        plan: 1,
        version,
        engine: plan.engine,
        digest: plan.digest,
        ok: plan.failures.length === 0,
        downgrade: plan.downgrade,
        failures: plan.failures,
        steps: plan.steps,
        files: [...plan.writes.keys()].map((path) => (path.startsWith(join(workspace, "/")) ? path.slice(workspace.length + 1) : path)),
    })}\n`,
);
