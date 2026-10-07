import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { packageRoot } from "@intentic/constants/node";
import { logsRoot } from "../logs/log-files.js";
import { WORK_SIGNAL_PATH, workSignalBody } from "../workload/work-signal.js";
import { bootFailureDocument } from "./boot/boot-failure.js";
import { type ExitMarker, MARKER_FILE } from "./boot/boot-marker.js";
import { restartResumeDocument } from "./restart-resume.js";
import { updateOutcomeDocument, updatePreparingDocument } from "./updates/staged-update.js";

// The files the host and this daemon share across the container's edge, spelled once here: `ic` writes some for the
// daemon to read and reads the rest, by path and field name, from Rust. golden/host-files.json is each one's path in
// the container and, for the ones whose shape is defined here, an example as JSON; ic's test
// (_sandbox/ic/src/sandbox/host_files.rs) holds its own paths, what it writes and what it reads to it. The update
// markers' shapes are the contract's, so their examples are its golden files. A change here that the committed file
// does not carry fails, naming the file; `INTENTIC_WRITE_GOLDEN=1` rewrites it, and ic's test then says whether ic still
// agrees.

const GOLDEN = join(packageRoot(import.meta.url), "golden", "host-files.json");

const AT = 1_791_240_330_000;

const files = {
    // ic writes it before a restart it makes, and the next boot reads it once (restart-resume.ts).
    restartResume: { path: join(HISTORY_ROOT, restartResumeDocument.path), example: restartResumeDocument.schema.parse({ askedAt: AT }) },
    // ic writes both; their examples are the contract's golden/update-outcome.json and golden/update-preparing.json.
    updateOutcome: { path: join(HISTORY_ROOT, updateOutcomeDocument.path) },
    updatePreparing: { path: join(HISTORY_ROOT, updatePreparingDocument.path) },
    // A boot that failed leaves it, and ic reads why a version it started never came up.
    bootFailure: {
        path: join(HISTORY_ROOT, bootFailureDocument.path),
        example: bootFailureDocument.schema.parse({
            at: AT,
            version: "1.400.0",
            error: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ssh2' imported from /opt/sandbox/dist/capabilities/credentials/ssh-keys.js\n    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:331:9)",
            step: "Reading the configuration",
        }),
    },
    // Every boot claims it, and ic counts a daemon's starts off `startedAt`.
    daemonExit: {
        path: join(logsRoot(HISTORY_ROOT), MARKER_FILE),
        example: { pid: 41, startTimeTicks: 1_208_311, state: "running", startedAt: AT } satisfies ExitMarker,
    },
    // How much a restart would cut, which ic asks before a restart it would make unasked.
    workSignal: {
        path: WORK_SIGNAL_PATH,
        example: JSON.parse(
            workSignalBody(2, AT, {
                bootedAt: AT - 60_000,
                previousBootAt: AT - 3_600_000,
                bootsInWindow: 2,
                storm: false,
                restartAskedAt: AT - 90_000,
            }),
        ) as unknown,
    },
};

test("golden/host-files.json is each shared file's path and example, as the host reads and writes them", () => {
    const expected = `${JSON.stringify(files, undefined, 2)}\n`;
    if (process.env["INTENTIC_WRITE_GOLDEN"] === "1") {
        writeFileSync(GOLDEN, expected);
    }
    expect(readFileSync(GOLDEN, "utf8")).toBe(expected);
});
