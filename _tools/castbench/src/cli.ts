import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type BudgetsInput, compareTable, judge, parseBudgets, verdictTable } from "./compare.js";
import { loadDaemon } from "./daemon.js";
import { measureEdge, tunnelDoor } from "./edge.js";
import { parseLink, STANDARD_LINKS } from "./link.js";
import type { RunFile } from "./results.js";
import { runMatrix, type Workload, WORKLOADS } from "./run.js";
import type { Size } from "./stage.js";
import { startStubCastd } from "./stub-castd.js";

// castbench's command line: `run` a matrix (and `--compare` it), `compare` a saved run, measure the `edge` hairpin, or
// stand up a `stub-castd`. README.md has every scenario.

const PACKAGE = new URL("../", import.meta.url).pathname;

// What castbench prints is its output, not a log: straight to stdout.
const say = (line = ""): void => {
    process.stdout.write(`${line}\n`);
};
const DEFAULT_BASELINE = join(PACKAGE, "baselines/legacy.json");
const DEFAULT_BUDGETS = join(PACKAGE, "budgets.json");

// The newest Chromium Playwright installed, unless CASTBENCH_CHROMIUM names one.
const defaultChromium = (): string => {
    const named = process.env["CASTBENCH_CHROMIUM"];
    if (named !== undefined && named !== "") {
        return named;
    }
    const root = join(homedir(), ".cache/ms-playwright");
    const builds = existsSync(root)
        ? readdirSync(root)
              .filter((entry) => /^chromium-\d+$/u.test(entry))
              .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]))
        : [];
    const found = builds.map((build) => join(root, build, "chrome-linux64/chrome")).find((path) => existsSync(path));
    if (found === undefined) {
        throw new Error(`no Chromium under ${root}: install Playwright's (npx playwright install chromium) or set CASTBENCH_CHROMIUM`);
    }
    return found;
};

const readJson = <T>(path: string): T => {
    // SAFETY: castbench's own files (a run it wrote, its budgets); parseBudgets checks what judging reads.
    return JSON.parse(readFileSync(path, "utf8")) as T;
};

const parseSize = (text: string): Size => {
    const match = /^(\d+)x(\d+)$/u.exec(text);
    if (match === null) {
        throw new Error(`a size is <width>x<height>, not "${text}"`);
    }
    return { width: Number(match[1]), height: Number(match[2]) };
};

const parseWorkloads = (text: string): Workload[] =>
    text.split(",").map((name) => {
        const workload = WORKLOADS.find((known) => known === name);
        if (workload === undefined) {
            throw new Error(`no workload "${name}": pick from ${WORKLOADS.join(", ")}`);
        }
        return workload;
    });

// Prints the run against the baseline and every budget; true when a budget failed.
const printComparison = (current: RunFile, baselinePath: string, budgetsPath: string): boolean => {
    const baseline = existsSync(baselinePath) ? readJson<RunFile>(baselinePath) : undefined;
    const verdicts = judge(current.runs, parseBudgets(readJson<BudgetsInput>(budgetsPath)));
    const loadOf = (file: RunFile): string => (file.load === undefined ? "load unrecorded" : `load ${file.load.before.join(" ")} → ${file.load.after.join(" ")}`);
    say(`\nthis run: ${loadOf(current)}`);
    say(`${baseline === undefined ? `no baseline at ${baselinePath}` : `against ${baselinePath} (recorded ${baseline.recordedAt}, ${loadOf(baseline)})`}\n`);
    say(compareTable(current, baseline));
    say(`\nbudgets (${budgetsPath})\n`);
    say(verdictTable(verdicts));
    return verdicts.some((verdict) => verdict.pass === false);
};

const run = async (argv: string[]): Promise<number> => {
    const { values } = parseArgs({
        args: argv,
        options: {
            pipeline: { type: "string", default: "legacy" },
            workload: { type: "string", default: WORKLOADS.join(",") },
            link: { type: "string", default: STANDARD_LINKS.map((link) => link.name).join(",") },
            seconds: { type: "string", default: "12" },
            warmup: { type: "string", default: "3" },
            "queue-ms": { type: "string", default: "200" },
            size: { type: "string", default: "1280x880" },
            stage: { type: "string" },
            chromium: { type: "string" },
            "no-probe": { type: "boolean", default: false },
            out: { type: "string" },
            dump: { type: "string" },
            compare: { type: "boolean", default: false },
            baseline: { type: "string", default: DEFAULT_BASELINE },
            budgets: { type: "string", default: DEFAULT_BUDGETS },
            strict: { type: "boolean", default: false },
            "castd-command": { type: "string" },
            "castd-socket": { type: "string" },
            "castd-pid": { type: "string" },
            "castd-token": { type: "string" },
            "castd-key-file": { type: "string" },
            session: { type: "string", default: "castbench" },
            peer: { type: "boolean", default: false },
        },
    });
    if (values.pipeline !== "legacy" && values.pipeline !== "castd") {
        throw new Error(`--pipeline is legacy or castd, not "${values.pipeline}"`);
    }
    const stage = values.stage ?? (values.pipeline === "legacy" ? "daemon" : "window");
    if (stage !== "daemon" && stage !== "window") {
        throw new Error(`--stage is daemon or window, not "${stage}"`);
    }
    const castd = {
        session: values.session,
        command: values["castd-command"],
        socket: values["castd-socket"],
        pid: values["castd-pid"] === undefined ? undefined : Number(values["castd-pid"]),
        token: values["castd-token"],
        keyFile: values["castd-key-file"],
    };
    const result = await runMatrix({
        pipeline: values.pipeline,
        workloads: parseWorkloads(values.workload),
        links: values.link.split(",").map(parseLink),
        seconds: Number(values.seconds),
        warmupSeconds: Number(values.warmup),
        queueMs: values["queue-ms"] === "inf" ? Infinity : Number(values["queue-ms"]),
        size: parseSize(values.size),
        stage,
        chromium: values.chromium ?? defaultChromium(),
        probe: !values["no-probe"],
        castd,
        peer: values.peer,
        dump: values.dump,
        log: say,
    });
    if (values.out !== undefined) {
        writeFileSync(values.out, `${JSON.stringify(result, null, 4)}\n`);
        say(`\nwrote ${values.out}`);
    }
    const failed = values.compare ? printComparison(result, values.baseline, values.budgets) : false;
    return failed && values.strict ? 1 : 0;
};

const compare = (argv: string[]): number => {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            baseline: { type: "string", default: DEFAULT_BASELINE },
            budgets: { type: "string", default: DEFAULT_BUDGETS },
            strict: { type: "boolean", default: false },
        },
    });
    const [path] = positionals;
    if (path === undefined) {
        throw new Error("castbench compare <run.json> [--baseline <file>] [--budgets <file>] [--strict]");
    }
    const failed = printComparison(readJson<RunFile>(path), values.baseline, values.budgets);
    return failed && values.strict ? 1 : 0;
};

// What netd remembers of Node's word, the tunnel among it (netd's remember.rs).
const NETD_CONFIG = "/run/intentic/last-config.json";

const edge = async (argv: string[]): Promise<number> => {
    const { values } = parseArgs({
        args: argv,
        options: {
            url: { type: "string" },
            loopback: { type: "string", default: `http://127.0.0.1:${process.env["SANDBOX_PORT"] ?? "8787"}` },
            samples: { type: "string", default: "100" },
            door: { type: "string" },
            out: { type: "string" },
        },
    });
    const url = values.url ?? process.env["SANDBOX_PUBLIC_URL"];
    if (url === undefined || url === "") {
        throw new Error("castbench edge needs --url, or SANDBOX_PUBLIC_URL set, to know where the edge is");
    }
    // The door netd's tunnel dials, from its remembered config, unless one is given.
    const door = values.door ?? (existsSync(NETD_CONFIG) ? tunnelDoor(readFileSync(NETD_CONFIG, "utf8")) : undefined);
    const report = await measureEdge({ edge: url, loopback: values.loopback, samples: Number(values.samples), door, log: say });
    if (values.out !== undefined) {
        writeFileSync(values.out, `${JSON.stringify(report, null, 4)}\n`);
    }
    return 0;
};

const stubCastd = async (argv: string[]): Promise<number> => {
    const { values } = parseArgs({ args: argv, options: { display: { type: "string" }, socket: { type: "string" }, region: { type: "string" } } });
    const [x, y, width, height] = (values.region ?? "").split(",").map(Number);
    if (values.display === undefined || values.socket === undefined || [x, y, width, height].some((value) => value === undefined || Number.isNaN(value))) {
        throw new Error("castbench stub-castd --display :N --socket <path> --region x,y,width,height");
    }
    const region = { x: x!, y: y!, width: width!, height: height!, scale: 1 };
    const daemon = await loadDaemon();
    const display = { name: values.display, width: region.x + region.width, height: region.y + region.height };
    const input = daemon.xinput.startXInput(display);
    // Keys go where the pointer is on a display with no window manager: over the page.
    input.move(region.x + region.width / 2, region.y + region.height / 2);
    const stub = await startStubCastd({
        socket: values.socket,
        width: region.width,
        height: region.height,
        input,
        source: {
            start: (handlers) =>
                daemon.videocast.startVideocast(display, region, {
                    onCodec: handlers.onCodec,
                    onFrame: (frame) => handlers.onFrame(frame.bytes, frame.key),
                    onExit: () => undefined,
                }),
        },
    });
    const stop = (): void => {
        input.stop();
        void stub.close().then(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await new Promise(() => undefined);
    return 0;
};

const main = async (): Promise<number> => {
    const [command = "run", ...rest] = process.argv.slice(2);
    switch (command) {
        case "run":
            return run(rest);
        case "compare":
            return compare(rest);
        case "edge":
            return edge(rest);
        case "stub-castd":
            return stubCastd(rest);
        default:
            return run([command, ...rest]);
    }
};

main().then(
    (code) => process.exit(code),
    (error: Error) => {
        console.error(error.message);
        process.exit(1);
    },
);
