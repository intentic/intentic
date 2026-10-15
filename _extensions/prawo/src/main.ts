import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execBounded } from "@intentic/base/process";
import { findWorkspaceRoot } from "@intentic/connector-runtime";
import { asZone, civilDayIn, UTC } from "@intentic/sandbox-contract/time";
import { extensionCacheDir } from "@intentic/sandbox-contract/workspace-state";
import { Cache } from "./cache.js";
import { execute } from "./cli.js";
import { Law } from "./law/law.js";
import { Eli } from "./sources/eli.js";
import { createHttp } from "./sources/http.js";
import { Saos } from "./sources/saos.js";

/* THE `prawo` PROCESS (bin/prawo): the real network, the workspace's cache directory, and `fileq` for PDFs. */

// The extension's identity, which names its cache directory (extensionCacheDir).
const IDENTITY = "intentic.prawo";
// An act takes effect at midnight in Poland, so "today" for whether an amendment is in force is Warsaw's day.
const POLAND = asZone("Europe/Warsaw") ?? UTC;
const PDF_TIMEOUT_MS = 180_000;

// A PDF's text layer, page by page, as fileq reads it; fileq is on every sandbox's PATH.
const pdfText = async (bytes: Uint8Array): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "prawo-"));
    try {
        const file = join(dir, "act.pdf");
        await writeFile(file, bytes);
        return (await execBounded("fileq", ["read", "--plain", file], { timeoutMs: PDF_TIMEOUT_MS, maxOutput: 64 * 1024 * 1024 })).stdout;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

const defaultLimit = (): number => {
    const configured = Number(process.env["PRAWO_RESULTS_LIMIT"]);
    return Number.isInteger(configured) && configured >= 1 && configured <= 100 ? configured : 10;
};

// `prawo … | head` closes the pipe under us; EPIPE ends the command quietly instead of with a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
        throw error;
    }
});

const http = createHttp();
const argv = process.argv.slice(2);
const law = new Law({
    eli: new Eli(http),
    saos: new Saos(http),
    cache: new Cache(join(findWorkspaceRoot(process.env, process.cwd()), extensionCacheDir(IDENTITY)), () => new Date()),
    pdfText,
    today: () => civilDayIn(Date.now(), POLAND),
    refresh: argv.includes("--refresh"),
});
const output = await execute(argv, law, { limit: defaultLimit(), today: civilDayIn(Date.now(), POLAND) });
process.stdout.write(`${output.text}\n`);
process.exitCode = output.code;
