import { HISTORY_ROOT } from "@intentic/constants";
import { errorMessage } from "@intentic/base/errors";
import { HostSessionRefused, mintHostSession } from "./host-session.js";
import { readPlatformRow } from "../../store/platform-row.js";

// `ic sandbox session <slug>` runs this inside the container, as root, through `docker exec`
// (`node /opt/sandbox/dist/auth/host/host-session-cli.js`): a daemon session for the bound owner, proven by the machine
// that runs the sandbox (host-session.ts beside it says why that is a proof and what it may never do). One JSON line on
// stdout; a refusal is one sentence on stderr and an exit code from HOST_SESSION_EXIT. It reads the files the daemon reads, so it answers
// whether or not the daemon is up, and it never writes the token anywhere but stdout.

const historyRoot = process.env["HISTORY_ROOT"] ?? HISTORY_ROOT;

try {
    const answer = await mintHostSession({ historyRoot, platformId: () => readPlatformRow(historyRoot) });
    process.stdout.write(`${JSON.stringify(answer)}\n`);
} catch (error) {
    if (error instanceof HostSessionRefused) {
        process.stderr.write(`${error.message}\n`);
        process.exit(error.code);
    }
    process.stderr.write(`no session was made: ${errorMessage(error)}\n`);
    process.exit(1);
}
