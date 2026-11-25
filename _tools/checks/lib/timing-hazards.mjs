// What timing-hazards.mjs reads a test file for, kept callable on bare text so its suite can feed it some: test code
// that leans on the wall clock, a fixed port, a hand-rolled poll, a cold import inside a test, or a per-test timeout
// nobody explained. Between 2026-10-23 and 11-05, 18 of the 35 red stretches on main ended with a commit that took one
// of the first three out of a test (fake timers for a real wait, a held port for a fixed one, performance.now for
// Date.now), and the code under test was never the problem. Six runner processes share one box
// (docs/ops/ci-runner.md), so a wait sized on a quiet machine runs out on a busy one, and a port two jobs both want is
// taken by whichever binds first.
//
// Read by pattern, line by line, with braces counted to know whether a line sits inside a test's body or a loop's: a
// string literal spanning lines can mislead the count, which is why the findings are ratcheted per file and rule rather
// than pinned to a line.
import { INTEGRATION_NAME, MANUAL_NAME } from "../../constants/src/test-suites.mjs";

export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// A real wait this long or longer in a unit test is a guess about how fast the machine is. Under 100 ms it is a
// yield to let a microtask or a stream settle, which load slows but rarely past the per-test budget.
const SLEEP_FLOOR_MS = 100;

// Ports below this are well-known services a test names without binding (an https URL's 443).
const PORT_FLOOR = 1024;

// A file that installs fake timers or a fake system clock makes setTimeout and Date.now fake too, so their waits and
// sums there are not real time. Bun.sleep is real whatever the file installs.
const FAKE_CLOCK = /\buseFakeTimers\b|\bsetSystemTime\b|\binstall\(\s*\{[^}]*now|\bFakeTimers\b|\bcreateClock\b/u;

// A port the file binds: listen(N), listen({ port: N }), or a serve({ ... port: N }) on one line, N a number or a
// name the file assigns one (`const PORT = 4000`).
const BINDING = /\.listen\(\s*(?:\{\s*port:\s*)?(\w+)\b|\bserve\(\s*\{[^}]*\bport:\s*(\w+)\b/gu;
const NUMBER_CONSTANT = /\b(?:const|let)\s+(\w+)\s*=\s*(\d[\d_]{3,})\b/gu;
// A port named anywhere: a loopback URL's, or an options object's.
const PORT_LITERAL = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})\b|\b(?:port:\s*|\.listen\(\s*)(\d[\d_]{3,})\b/gu;

// A line that opens a test's body (`test("…", async () => {`, `it.each(…)("…", () => {`), and one that opens a loop.
const TEST_CALL = /(?<![\w$.])(?:test|it)(?:\.\w+(?:\([^)]*\))?)*\s*\(/u;
const LOOP = /^\s*(?:\}\s*)?(?:while\s*\(|for\s*(?:await\s*)?\(|do\s*\{)/u;
// A per-test timeout: the number after a test's body (`}, 20_000);`), a `{ timeout: N }` option on the test's own
// line, or a file-wide default.
const TRAILING_TIMEOUT = /^\s*\}\s*\)?\s*,\s*(\d[\d_]*)\s*\)/u;
const OPTION_TIMEOUT = /\btimeout:\s*\d/u;
const DEFAULT_TIMEOUT = /\b(?:setDefaultTimeout|jest\.setTimeout|vi\.setConfig)\s*\(/u;
// A module loaded inside a test's body: `await import("…")`, or vitest's importActual.
const IN_TEST_IMPORT = /\bawait\s+import\s*\(|\b(?:vi|jest)\.(?:importActual|requireActual)\s*[<(]/u;

const number = (text) => Number(text.replaceAll("_", ""));

// The real waits on one line: `[ms]`, from Bun.sleep, a setTimeout promise, or an awaited sleep/delay helper. In a
// file with fake timers only Bun.sleep is real.
const waitsOn = (line, fakeClock) =>
    [
        ...line.matchAll(/\bBun\.sleep(?:Sync)?\(\s*(\d[\d_]*)/gu),
        ...(fakeClock
            ? []
            : [
                  // new Promise((r) => setTimeout(r, 500)), and node:timers/promises' setTimeout(500)
                  ...line.matchAll(/\bnew Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\(\s*\1\s*,\s*(\d[\d_]*)/gu),
                  ...line.matchAll(/\bawait\s+(?:sleep|delay|wait|setTimeoutPromise|setTimeout)\(\s*(\d[\d_]*)\s*[,)]/gu),
              ]),
    ].map((found) => number(found.at(-1)));

export const RULE_WHY = {
    "fixed-port": "a fixed port collides with any other job on the box that wants it; listen on 0 and read the port back",
    "real-sleep": "a real wait in a unit test is a guess at the machine's speed; await the event, or use fake timers",
    "wall-clock-assertion": "an assertion on elapsed wall time fails whenever the box is busy; assert on the order of events, or fake the clock",
    "polling-loop": "a hand-rolled loop of sleeps guesses at timing and says nothing about what never became true; use waitFor from @intentic/testing",
    "in-test-import": "a module loaded inside a unit test's body compiles cold inside its timeout; import it at module scope or in beforeAll",
    "timeout-without-reason": "a per-test timeout hides a slow or hanging test; say on the line or the one above why this test needs the time",
};


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

// The code of a line without a trailing `//` comment (strings already emptied, so a URL's `//` is gone).
const withoutComment = (code) => code.replace(/\/\/.*$/u, "");

const isComment = (line) => /^\s*(?:\/\/|\/\*|\*)/u.test(line);

// A timeout's reason: a comment on its own line, or on the line right above.
const explained = (lines, at) => /\/\/|\/\*/u.test(codeOf(lines[at])) || (at > 0 && isComment(lines[at - 1]));

// What a file says about itself that the rules ask on every line.
const fileFacts = (path, text, lines) => ({
    integration: INTEGRATION_NAME.test(path) || MANUAL_NAME.test(path),
    fakeClock: FAKE_CLOCK.test(text),
    // Read from code only: a port bound in a string is a fixture (this scanner's own tests are full of them).
    ...boundPorts(lines.map(codeOf).join("\n")),
    // Names assigned a wall-clock difference, `const elapsed = Date.now() - started`.
    elapsed: new Set([...text.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*;?\s*$/gmu)].map((found) => found[1])),
});

const namesBoundPort = (line, file) =>
    [...line.matchAll(PORT_LITERAL)].some((hit) => file.bound.has(number(hit[1] ?? hit[2]))) ||
    [...line.matchAll(BINDING)].some((hit) => file.boundNames.has(hit[1] ?? hit[2]));

const assertsElapsed = (code, file) =>
    !file.fakeClock &&
    (/\bexpect\(\s*(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*\)\.toBe(?:Less|Greater)Than/u.test(code) ||
        [...file.elapsed].some((name) => new RegExp(`\\bexpect\\(\\s*${name}\\s*\\)\\.toBe(?:Less|Greater)Than`, "u").test(code)));

const setsTimeout = (code, opensTest) => (opensTest && OPTION_TIMEOUT.test(code) && !/\bwaitFor\s*\(/u.test(code)) || DEFAULT_TIMEOUT.test(code);

// Each rule asks one line, `{ line, code, at, file, stack, waits, opensTest }`, and answers the line it anchors to (a
// polling loop anchors to the loop) or undefined. Every rule but fixed-port reads the line's code, strings emptied:
// a port is spelled inside a URL string as often as not.
const LINE_RULES = [
    ["fixed-port", ({ line, file, at }) => (namesBoundPort(line, file) ? at : undefined)],
    ["real-sleep", ({ file, waits, at }) => (!file.integration && waits.some((ms) => ms >= SLEEP_FLOOR_MS) ? at : undefined)],
    ["wall-clock-assertion", ({ code, file, at }) => (assertsElapsed(code, file) ? at : undefined)],
    ["polling-loop", ({ stack, waits }) => (waits.some((ms) => ms > 0) ? stack.findLast((frame) => frame.kind === "loop")?.at : undefined)],
    ["in-test-import", ({ code, file, stack, at }) => (!file.integration && IN_TEST_IMPORT.test(code) && stack.some((frame) => frame.kind === "test") ? at : undefined)],
    ["timeout-without-reason", ({ code, opensTest, lines, at }) => (setsTimeout(code, opensTest) && !explained(lines, at) ? at : undefined)],
];

// Moves the open braces past one line, each `{ kind, at }` (a test's body, a loop's, any other block); answers whether
// the line closed a test's body.
const countBraces = (stack, code, kind, at) => {
    let closedTest = false;
    for (const char of code) {
        if (char === "{") {
            stack.push({ kind, at });
        } else if (char === "}") {
            closedTest = stack.pop()?.kind === "test" || closedTest;
        }
    }
    return closedTest;
};

// Every hazard in one test file's text: `{ rule, line, text }`, lines counted from 1, in line order, each anchor once
// per rule (a loop of three sleeps is one polling loop).
export const hazardsIn = (path, text) => {
    const lines = text.split("\n");
    const file = fileFacts(path, text, lines);
    const found = new Map();
    const add = (rule, at) => found.set(`${rule}@${at}`, { rule, line: at + 1, text: lines[at].trim().slice(0, 160) });
    const stack = [];
    lines.forEach((line, at) => {
        if (isComment(line)) {
            return;
        }
        const code = withoutComment(codeOf(line));
        const opensTest = TEST_CALL.test(code);
        const asked = { line, code, at, file, stack, lines, opensTest, waits: waitsOn(code, file.fakeClock) };
        for (const [rule, anchor] of LINE_RULES) {
            const anchored = anchor(asked);
            if (anchored !== undefined) {
                add(rule, anchored);
            }
        }
        // Braces close before the trailing timeout is judged, so it sees the frame the line ends.
        const closedTest = countBraces(stack, code, opensTest ? "test" : LOOP.test(code) ? "loop" : "block", at);
        if (closedTest && TRAILING_TIMEOUT.test(code) && !explained(lines, at)) {
            add("timeout-without-reason", at);
        }
    });
    return [...found.values()].toSorted((a, b) => a.line - b.line);
};
