#!/usr/bin/env node
// Test code that leans on the wall clock or a fixed port, reported and never failed. Between 2026-10-23 and 11-05, 18 of
// the 35 red stretches on main ended with a commit that took one of these out of a test (fake timers for a real wait,
// a held port for a fixed one, performance.now for Date.now), and the code under test was never the problem. Six
// runner processes share one box (docs/ops/ci-runner.md), so a wait sized on a quiet machine runs out on a busy one,
// and a port two jobs both want is taken by whichever binds first.
//
// It runs in CI only (ci.yml's preflight) and REPORTS: every occurrence already on main is listed in the step summary,
// and the first few are warning annotations on their lines, so the next person editing that file sees it. It exits 0
// whatever it finds, so adding it broke nothing on main.
//
// Usage: timing-hazards.mjs [--json]; reads every tracked test file (git ls-files) from the repository root.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { INTEGRATION_NAME } from "../../constants/src/test-suites.mjs";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// A real wait this long or longer in a unit test is a guess about how fast the machine is. Under 100 ms it is a
// yield to let a microtask or a stream settle, which load slows but rarely past the per-test budget.
export const SLEEP_FLOOR_MS = 100;

// Ports below this are well-known services a test names without binding (an https URL's 443).
const PORT_FLOOR = 1024;

// GitHub keeps 10 warning annotations per step and drops the rest; the summary lists every one.
export const ANNOTATIONS = 10;

// A file that installs fake timers or a fake system clock makes setTimeout and Date.now fake too, so their waits and
// sums there are not real time. Bun.sleep is real whatever the file installs.
const FAKE_CLOCK = /\buseFakeTimers\b|\bsetSystemTime\b|\binstall\(\s*\{[^}]*now|\bFakeTimers\b|\bcreateClock\b/u;

// A port the file binds: listen(N), listen({ port: N }), or a serve({ ... port: N }) on one line, N a number or a
// name the file assigns one (`const PORT = 4000`).
const BINDING = /\.listen\(\s*(?:\{\s*port:\s*)?(\w+)\b|\bserve\(\s*\{[^}]*\bport:\s*(\w+)\b/gu;
const NUMBER_CONSTANT = /\b(?:const|let)\s+(\w+)\s*=\s*(\d[\d_]{3,})\b/gu;
// A port named anywhere: a loopback URL's, or an options object's.
const PORT_LITERAL = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})\b|\b(?:port:\s*|\.listen\(\s*)(\d[\d_]{3,})\b/gu;

const number = (text) => Number(text.replaceAll("_", ""));

const RULES = [
    {
        id: "fixed-port",
        // A port is spelled inside a URL string as often as not.
        inStrings: true,
        why: "a fixed port collides with any other job on the box that wants it; listen on 0 and read the port back",
        // The line that binds it (listen(4000), listen({ port: 4000 }), Bun.serve({ port: 4000 })), and any other line
        // naming that same port (a localhost:4000 URL, a port: 4000 option). A port the file never binds is a fixture
        // string, which collides with nothing.
        match: (line, file) =>
            [...line.matchAll(PORT_LITERAL)].some((found) => file.bound.has(number(found[1] ?? found[2]))) ||
            [...line.matchAll(BINDING)].some((found) => file.boundNames.has(found[1] ?? found[2])),
    },
    {
        id: "real-sleep",
        why: "a real wait in a unit test is a guess at the machine's speed; await the event, or use fake timers",
        match: (line, file) => {
            if (file.integration) {
                return false;
            }
            const sleeps = [
                ...line.matchAll(/\bBun\.sleep(?:Sync)?\(\s*(\d[\d_]*)/gu),
                ...(file.fakeClock
                    ? []
                    : [
                          // new Promise((r) => setTimeout(r, 500)), and node:timers/promises' setTimeout(500)
                          ...line.matchAll(/\bnew Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\1\s*,\s*(\d[\d_]*)/gu),
                          ...line.matchAll(/\bawait\s+(?:sleep|delay|wait|setTimeoutPromise|setTimeout)\(\s*(\d[\d_]*)\s*[,)]/gu),
                      ]),
            ];
            return sleeps.some((found) => number(found.at(-1)) >= SLEEP_FLOOR_MS);
        },
    },
    {
        id: "wall-clock-assertion",
        why: "an assertion on elapsed wall time fails whenever the box is busy; assert on the order of events, or fake the clock",
        // expect(Date.now() - started).toBeLessThan(5_000), and the same on a variable holding that difference
        match: (line, file) =>
            !file.fakeClock &&
            (/\bexpect\(\s*(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*\)\.toBe(?:Less|Greater)Than/u.test(line) ||
                [...file.elapsed].some((name) => new RegExp(`\\bexpect\\(\\s*${name}\\s*\\)\\.toBe(?:Less|Greater)Than`, "u").test(line))),
    },
];

const isPort = (port) => port >= PORT_FLOOR && port <= 65_535;

// The ports a file binds, as numbers, and the names it binds them through.
const boundPorts = (text) => {
    const constants = new Map([...text.matchAll(NUMBER_CONSTANT)].map((found) => [found[1], number(found[2])]));
    const bound = new Set();
    const boundNames = new Set();
    for (const found of text.matchAll(BINDING)) {
        const target = found[1] ?? found[2];
        const port = /^\d/u.test(target) ? number(target) : constants.get(target);
        if (port !== undefined && isPort(port)) {
            bound.add(port);
            if (!/^\d/u.test(target)) {
                boundNames.add(target);
            }
        }
    }
    return { bound, boundNames };
};

// A line with its string literals emptied, so a test about code (a scanner's fixture `await sleep(2000)`) is not
// mistaken for the code. Single-line literals only; a template spanning lines keeps its later lines.
export const codeOf = (line) => line.replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, (literal) => `${literal[0]}${literal[0]}`);

// Every hazard in one test file's text: `{ rule, line, text }`, lines counted from 1.
export const hazardsIn = (path, text) => {
    const file = {
        integration: INTEGRATION_NAME.test(path),
        fakeClock: FAKE_CLOCK.test(text),
        // Read from code only: a port bound in a string is a fixture (this scanner's own tests are full of them).
        ...boundPorts(text.split("\n").map(codeOf).join("\n")),
        // Names assigned a wall-clock difference, `const elapsed = Date.now() - started`.
        elapsed: new Set(
            [...text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*;?\s*$/gmu)].map((found) => found[1]),
        ),
    };
    return text.split("\n").flatMap((line, at) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*")) {
            return [];
        }
        const stripped = codeOf(line);
        return RULES.filter((rule) => rule.match(rule.inStrings ? line : stripped, file)).map((rule) => ({
            rule: rule.id,
            line: at + 1,
            text: code.slice(0, 160),
        }));
    });
};

export const RULE_WHY = Object.fromEntries(RULES.map(({ id, why }) => [id, why]));

const trackedTests = () => {
    const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) {
        throw new Error(`git ls-files failed: ${listed.stderr}`);
    }
    return listed.stdout.split("\0").filter((path) => TEST_FILE.test(path) && !path.startsWith("refs/") && !path.includes("/node_modules/"));
};

// Every hazard in the tracked test files, `{ path, rule, line, text }`, in path order.
export const scan = (paths, read = (path) => readFileSync(path, "utf8")) =>
    paths.toSorted().flatMap((path) => {
        let text;
        try {
            text = read(path);
        } catch {
            // allow(silent-catch): a path git lists that the checkout lacks (a sparse checkout) holds no hazard to report
            return [];
        }
        return hazardsIn(path, text).map((hazard) => ({ path, ...hazard }));
    });

// The step summary: a count per rule, then every occurrence, so the list of offenders stays visible on every run.
export const summaryOf = (found) => {
    const lines = ["### Timing and port hazards in tests (reported, not failed)", ""];
    if (found.length === 0) {
        return [...lines, "None found.", ""].join("\n");
    }
    lines.push("| rule | occurrences | files | fix |", "| --- | --- | --- | --- |");
    for (const [id, why] of Object.entries(RULE_WHY)) {
        const ofRule = found.filter(({ rule }) => rule === id);
        lines.push(`| \`${id}\` | ${ofRule.length} | ${new Set(ofRule.map(({ path }) => path)).size} | ${why} |`);
    }
    lines.push("", "<details><summary>Every occurrence</summary>", "");
    for (const { path, line, rule, text } of found) {
        lines.push(`- \`${path}:${line}\` ${rule}: \`${text.replaceAll("`", "'")}\``);
    }
    lines.push("", "</details>", "");
    return lines.join("\n");
};

// `::warning` lines for the first `limit` occurrences, each on its own file and line.
export const annotationsOf = (found, limit = ANNOTATIONS) => {
    const shown = found
        .slice(0, limit)
        .map(({ path, line, rule }) => `::warning file=${path},line=${line},title=timing hazard (${rule})::${RULE_WHY[rule]}`);
    return found.length > limit ? [...shown, `::warning title=timing hazards::${found.length - limit} more in the step summary`] : shown;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const found = scan(trackedTests());
    if (process.argv.includes("--json")) {
        console.log(JSON.stringify(found, null, 2));
    } else {
        for (const line of annotationsOf(found)) {
            console.log(line);
        }
        const summary = summaryOf(found);
        if (process.env.GITHUB_STEP_SUMMARY) {
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
        } else {
            console.log(summary);
        }
    }
}
