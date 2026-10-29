#!/usr/bin/env node
// The demo's dev server, started one of two ways.
//
// - BY HAND, or anywhere outside an agent's turn (no conversation stamp): Vite in the foreground on 47146, as it always
//   was; arguments go to Vite.
// - FROM AN AGENT'S TURN (INTENTIC_TURN_OWNER names its conversation): a MANAGED PREVIEW, one per conversation. A second
//   start finds the first and prints its address; a new one starts in the background, writes its record
//   (@intentic/constants/dev-previews), prints its address once it answers, and the command returns. The server
//   outlives the command and the turn, keeps its record current while it is used, and stops by itself after 10 minutes
//   with no request and no open page (vite.config.ts, previewKeeper). At most three run at once across the sandbox:
//   starting a fourth stops the least recently used, and whoever owned that one is told why on their next start.
//   `--stop` stops this conversation's; `--list` lists every one.
//
// Why (2026-10-26): five to seven conversations each ran a demo server of their own at 1.5-1.9 GB, up for the whole
// turn and idle most of it, on one 21 GB sandbox; and the skill's `pkill -f vite`, run by one, stopped all of them.
//
// Each preview is its own origin, `http://<conversation>.demo.localhost:<port>/demo/`, so one conversation's seeded
// sign-in and chosen look never land in another's page. The port is the conversation's own (preferredPort) unless
// something else holds it, so the origin survives a restart.
//
// INTENTIC_PREVIEW_DIRECT=1 runs Vite in the foreground even in a turn, for the rare check that needs its console.
// A PORT in the environment (the `demo` target in the repository's .intentic/run.json, run in the sandbox) does the same
// on that port.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import {
    clearEnded,
    endedNote,
    freePreviewPort,
    hostLabel,
    OWNER_ENV,
    openPreviewLog,
    overCap,
    pidNamespaceOf,
    preferredPort,
    PREVIEW_CAP,
    PREVIEW_IDLE_MS,
    previewsDir,
    readRecords,
    RECORD_ENV,
    recordPath,
    startTicksOf,
    stopPreview,
    touchRecord,
    writeRecord,
} from "@intentic/constants/dev-previews";

const LABEL = "demo";
const ROOT = join(import.meta.dirname, "..");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
// The two stamps a process carries that are not a conversation (_sandbox/sandbox/src/seams/workload-stamp.ts).
const NOT_CONVERSATIONS = new Set(["daemon", "one-shot"]);
// How long a cold start may take to answer: the first start of a new optimizer cache bundles monaco, mermaid and
// shiki, and one waiting on another's priming waits for that too (vite.shared.ts).
const READY_MS = 6 * 60_000;
const USAGE = `pnpm -C _site/demo dev [--stop | --list]   (in an agent's turn; \`preview demo\` is the same)

  (no flag)  this conversation's demo preview: started, or found already running; prints its address
  --stop     stop this conversation's preview
  --list     every running preview, and why this conversation's last one stopped

Outside a turn, or with INTENTIC_PREVIEW_DIRECT=1, it runs Vite in the foreground and passes arguments to it.`;

const say = (line = "") => process.stdout.write(`${line}\n`);

const ago = (at) => {
    const minutes = Math.round((Date.now() - at) / 60_000);
    return minutes < 1 ? "just now" : minutes < 90 ? `${String(minutes)} min ago` : `${String(Math.round(minutes / 60))} h ago`;
};

const syncExtensions = () => spawnSync(process.execPath, [join(ROOT, "scripts", "sync-extensions.mjs")], { cwd: ROOT, stdio: "inherit" }).status ?? 1;

// Vite in the foreground, as before managed previews: its exit is this script's.
const direct = (args) => {
    const synced = syncExtensions();
    if (synced !== 0) {
        process.exit(synced);
    }
    const vite = spawn(process.execPath, [VITE, ...args], { cwd: ROOT, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => vite.kill(signal));
    }
    vite.on("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
};

// Whether the server answers at all on its port, any status: an answer means it is listening and serving.
const answers = (port) =>
    new Promise((resolve) => {
        const request = get({ host: "127.0.0.1", port, path: "/demo/", timeout: 2_000 }, (response) => {
            response.resume();
            resolve(true);
        });
        request.on("error", () => resolve(false));
        request.on("timeout", () => {
            request.destroy();
            resolve(false);
        });
    });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tail = (path, lines = 20) => {
    try {
        return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
        // allow(silent-catch): a log that was never written has nothing to show.
        return "";
    }
};

const address = (record) => {
    say(`Demo preview for ${record.conversation}: ${record.url}`);
    say(`  curl and anything that cannot resolve *.localhost: http://127.0.0.1:${String(record.port)}/demo/ (another origin, same server)`);
    say(`  It keeps running across this conversation's turns and stops by itself after ${String(PREVIEW_IDLE_MS / 60_000)} minutes with no request and no open page.`);
    say(`  Log: ${record.log}. Stop it: preview demo --stop (or pnpm -C _site/demo dev --stop).`);
};

const reportEnded = (dir, owner) => {
    const ended = endedNote(dir, owner, LABEL);
    if (ended !== undefined) {
        say(`Your last demo preview was stopped ${ago(ended.at)}: ${ended.reason}.`);
        clearEnded(dir, owner, LABEL);
    }
};

const start = async (owner) => {
    const dir = previewsDir();
    const records = readRecords(dir);
    const mine = records.find((record) => record.conversation === owner && record.label === LABEL);
    if (mine !== undefined) {
        touchRecord(recordPath(dir, owner, LABEL));
        say("Already running.");
        address(mine);
        return 0;
    }
    reportEnded(dir, owner);
    const synced = syncExtensions();
    if (synced !== 0) {
        return synced;
    }
    for (const victim of overCap(records)) {
        say(`Stopping ${victim.conversation}'s demo preview, the least recently used, to keep ${String(PREVIEW_CAP)} running at most.`);
        await stopPreview(dir, victim, `cap: ${owner} started one while ${String(PREVIEW_CAP)} were running, and this one was used least recently`);
    }
    const port = await freePreviewPort(new Set(records.map((record) => record.port)), preferredPort(owner));
    if (port === undefined) {
        say("demo: every preview port (47150-47199) is taken; `preview demo --list` shows what holds them.");
        return 1;
    }
    const { path: log, fd: out } = openPreviewLog(dir, owner, LABEL);
    const path = recordPath(dir, owner, LABEL);
    // Its own session, so the turn's terminal closing does not take it along, and its own process group, the unit the
    // keepers signal.
    const child = spawn(process.execPath, [VITE, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, [RECORD_ENV]: path },
    });
    closeSync(out);
    child.unref();
    const running = () => child.exitCode === null && child.signalCode === null;
    const pid = child.pid ?? 0;
    const record = {
        v: 1,
        conversation: owner,
        label: LABEL,
        pid,
        startTicks: startTicksOf(pid) ?? "0",
        pidNamespace: pidNamespaceOf(),
        port,
        url: `http://${hostLabel(owner)}.demo.localhost:${String(port)}/demo/`,
        root: ROOT,
        log,
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
    };
    writeRecord(dir, record);
    say(`Starting the demo preview on port ${String(port)} (a cold optimizer cache takes a minute or two)…`);
    const deadline = Date.now() + READY_MS;
    while (running() && Date.now() < deadline && !(await answers(port))) {
        await delay(500);
    }
    if (!running() || !(await answers(port))) {
        const exited = !running();
        say(exited ? "demo: the server exited before it answered. Its log:" : "demo: the server did not answer in time. Its log so far:");
        say(tail(log));
        if (!exited) {
            await stopPreview(dir, record, "it did not answer within six minutes of starting");
            clearEnded(dir, owner, LABEL);
        }
        return 1;
    }
    address(record);
    return 0;
};

const stop = async (owner) => {
    const dir = previewsDir();
    const mine = readRecords(dir).find((record) => record.conversation === owner && record.label === LABEL);
    if (mine === undefined) {
        say("This conversation has no demo preview running.");
        reportEnded(dir, owner);
        return 0;
    }
    await stopPreview(dir, mine, `stopped by ${owner} itself`);
    clearEnded(dir, owner, LABEL);
    say(`Stopped ${mine.url}.`);
    return 0;
};

const list = (owner) => {
    const dir = previewsDir();
    const records = readRecords(dir);
    if (records.length === 0) {
        say("No previews are running.");
    }
    for (const record of records) {
        const yours = record.conversation === owner ? "  (this conversation)" : "";
        say(`${record.label}  ${record.conversation}  ${record.url}  started ${ago(record.startedAt)}, last used ${ago(record.lastActiveAt)}${yours}`);
    }
    say(`At most ${String(PREVIEW_CAP)} run at once; one unused for ${String(PREVIEW_IDLE_MS / 60_000)} minutes stops by itself.`);
    if (owner !== undefined) {
        reportEnded(dir, owner);
    }
    return 0;
};

const main = async () => {
    const args = process.argv.slice(2);
    const owner = process.env[OWNER_ENV];
    // A run that is handed a PORT is the sandbox running the repository's `demo` target (.intentic/run.json): Vite in the
    // foreground of its terminal, on that port, behind the preview proxy (vite.config.ts, allowedHosts), never a managed
    // preview.
    const assigned = process.env["PORT"];
    const started = assigned !== undefined && assigned !== "";
    const inTurn = !started && owner !== undefined && owner !== "" && !NOT_CONVERSATIONS.has(owner) && process.env["INTENTIC_PREVIEW_DIRECT"] !== "1";
    if (args.includes("--list")) {
        process.exit(list(inTurn ? owner : undefined));
    }
    if (!inTurn) {
        if (args.includes("--stop")) {
            say("demo: --stop stops a conversation's managed preview, and this shell is not in one.");
            process.exit(2);
        }
        direct(started ? [...args, "--port", assigned] : args);
        return;
    }
    if (args.includes("--help") || args.includes("-h")) {
        say(USAGE);
        process.exit(0);
    }
    if (args.includes("--stop")) {
        process.exit(await stop(owner));
    }
    if (args.length > 0) {
        say(
            `demo: in an agent's turn the demo runs as this conversation's managed preview, on a port of its own; ${args.join(" ")} is not taken here.\n`,
        );
        say(USAGE);
        process.exit(2);
    }
    if (!existsSync(VITE)) {
        say(`demo: ${VITE} is missing: install the workspace's dependencies first.`);
        process.exit(2);
    }
    process.exit(await start(owner));
};

await main();
