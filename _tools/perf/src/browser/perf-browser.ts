#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser } from "playwright";
import { conclude, type Reading } from "../baseline.js";
import { startDemo, type DemoServer } from "./demo.js";
import { describeDisagreements, disagreements } from "./determinism.js";
import type { ProbeOptions } from "./page-probe.js";
import { readingOf } from "./reading.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import { Session, VIEWPORT } from "./session.js";

const USAGE = `perf:browser [--update] [--only a,b] [--runs N]

  Counts what each scenario costs the editor in a real Chromium against the demo (_site/demo): Vue renders and mounts,
  V8 function calls, layouts and style recalcs, DOM mutations. The clock is fake and every count is exact, so a reading
  is judged against baselines/browser.json with no tolerance. --update re-records it; --runs N measures each scenario N
  times in fresh contexts and fails if any count differs between them.

  scenarios:
${SCENARIOS.map((scenario) => `    ${scenario.name.padEnd(20)} ${scenario.about}`).join("\n")}
`;

const here = import.meta.dirname;
const repo = repoRoot(here);
const baselinePath = join(here, "..", "..", "baselines", "browser.json");

// The curated recording: three agents and four open chats. Its two listed extensions are fetched from GitHub by the
// demo's sync, so only the two compiled in are switched on and a synced `vendor/` cannot change a count.
const PROBE: ProbeOptions = { mode: "default", extensions: ["intentic.pipelines", "intentic.viewers"], seed: 0x5eed };

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
};
if (args.includes("--help")) {
    process.stdout.write(USAGE);
    process.exit(0);
}
const only = flag("--only")?.split(",");
const unknown = only?.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name)) ?? [];
if (unknown.length > 0) {
    process.stderr.write(`unknown scenario ${unknown.join(", ")}; have ${SCENARIOS.map((scenario) => scenario.name).join(", ")}\n`);
    process.exit(2);
}
const selected = only === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => only.includes(scenario.name));
const runs = Number(flag("--runs") ?? "1");
if (!Number.isInteger(runs) || runs < 1) {
    process.stderr.write(`--runs takes a whole number of at least 1, not ${flag("--runs")}\n`);
    process.exit(2);
}

const versionOf = (path: string): string => (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;

const measure = async (browser: Browser, server: DemoServer, scenario: Scenario): Promise<Reading> => {
    const session = await Session.open(browser, server.origin, PROBE);
    const logged = server.log().length;
    try {
        await scenario.prepare(session);
        const reading = readingOf(await session.measure(() => scenario.act(session), scenario.navigations), scenario.frames);
        // Vite announces a late dependency optimisation, and the page reload it pushes, on its own output.
        const said = server.log().slice(logged);
        if (/optimized dependencies changed|reloading/iu.test(said)) {
            throw new Error(`the demo server re-optimised dependencies during ${scenario.name}:\n${said}`);
        }
        return reading;
    } finally {
        await session.close();
    }
};

const started = Date.now();
const seconds = (since: number): string => `${((Date.now() - since) / 1000).toFixed(0)}s`;
const server = await startDemo(repo);
const browser = await chromium.launch({ channel: "chromium" });
const chromiumVersion = browser.version();
const readings = new Map<string, Reading[]>();
try {
    // Vite optimises dependencies on the first load after --force and would reload a measured page for any it finds
    // late; the shell prefetches every view at idle, so one settled board finds them all.
    const warm = await Session.open(browser, server.origin, PROBE);
    await warm.open("/demo/agents", 1_000);
    await warm.close();
    process.stderr.write(`demo up at ${server.origin} and warm in ${seconds(started)}\n`);

    for (const scenario of selected) {
        for (let run = 0; run < runs; run += 1) {
            const since = Date.now();
            const reading = await measure(browser, server, scenario);
            readings.set(scenario.name, [...(readings.get(scenario.name) ?? []), reading]);
            process.stderr.write(`  ${scenario.name}${runs > 1 ? ` run ${run + 1}/${runs}` : ""}: ${seconds(since)}\n`);
        }
    }
    process.stderr.write(`measured ${selected.length} scenarios × ${runs} in ${seconds(started)}\n\n`);
} finally {
    await browser.close();
    await server.stop();
}

const unstable = selected.map((scenario) => describeDisagreements(scenario.name, disagreements(readings.get(scenario.name) ?? []))).filter(Boolean);
if (unstable.length > 0) {
    process.stdout.write(`not deterministic across ${runs} runs (each value in run order):\n${unstable.join("\n")}\n`);
    process.exit(1);
}
if (runs > 1) {
    process.stdout.write(`all ${selected.length} scenarios read identically across ${runs} fresh contexts\n\n`);
}

const require = createRequire(import.meta.url);
const outcome = conclude({
    path: baselinePath,
    // Every run agreed, so the first one is the reading.
    measured: Object.fromEntries(selected.map((scenario) => [scenario.name, readings.get(scenario.name)![0]!])),
    host: {
        chromium: chromiumVersion,
        playwright: versionOf(require.resolve("playwright/package.json")),
        vue: versionOf(join(repo, "_editor", "web", "node_modules", "vue", "package.json")),
        viewport: `${VIEWPORT.width}x${VIEWPORT.height}@1`,
        platform: `${process.platform}-${process.arch}`,
    },
    tolerance: () => 0,
    update: args.includes("--update"),
    complete: only === undefined,
    binding: ["chromium", "playwright", "viewport", "platform"],
    rerecord: `pnpm perf:browser --update${only === undefined ? "" : ` --only ${only.join(",")}`}`,
});
process.stdout.write(`${outcome.text}\n`);
process.exit(outcome.ok ? 0 : 1);
