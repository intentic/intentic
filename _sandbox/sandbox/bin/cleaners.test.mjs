import { expect, test } from "vitest";
import { filterOutput } from "./agent-output-filter.mjs";
import { CACHE_MARKER, CLEANERS, cleanLines, collapseCached, parseCleaners, sessionKeyFromLog } from "./cleaners.mjs";

// An in-memory stand-in for the file-backed cache store, so cache tests stay deterministic (no disk).
const memoryStore = () => {
    const map = new Map();
    return { lookup: (key) => map.get(key), record: (key, value) => map.set(key, value) };
};

test("parseCleaners: empty/undefined enables everything", () => {
    expect(parseCleaners("")).toEqual(new Set(CLEANERS));
    expect(parseCleaners(undefined)).toEqual(new Set(CLEANERS));
});

test("parseCleaners: allow-list selects only the named cleaners", () => {
    expect(parseCleaners("test,pnpm")).toEqual(new Set(["test", "pnpm"]));
});

test("parseCleaners: default-minus disables the named cleaners", () => {
    const set = parseCleaners("-test,-cap");
    expect(set.has("test")).toBe(false);
    expect(set.has("cap")).toBe(false);
    expect(set.has("pnpm")).toBe(true);
});

test("parseCleaners: unknown tokens are ignored (fail-open), never thrown", () => {
    expect(parseCleaners("nonsense")).toEqual(new Set(CLEANERS)); // all tokens unknown → all on
    expect(parseCleaners("test,bogus")).toEqual(new Set(["test"])); // known kept, unknown dropped
    // A retired cleaner id left in an owner's saved spec reads as a typo, not a crash: the spec degrades to the
    // allow-list it can still honour rather than losing the whole setting.
    expect(parseCleaners("git,pnpm")).toEqual(new Set(["pnpm"]));
});

test("cleanLines: strips pnpm progress on success when enabled", () => {
    const lines = ["Progress: resolved 100", "added 5 packages", "done"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "0", enabled: new Set(CLEANERS) }).lines).toEqual(["added 5 packages", "done"]);
});

test("cleanLines: a disabled cleaner leaves its noise untouched", () => {
    const lines = ["Progress: resolved 100", "added 5 packages"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "0", enabled: parseCleaners("-pnpm") }).lines).toEqual(lines);
});

test("cleanLines: failure keeps everything (no command strip)", () => {
    const lines = ["Progress: resolved 100", "error: boom"];
    expect(cleanLines(lines, { command: "pnpm install", exitCode: "1", enabled: new Set(CLEANERS) }).lines).toEqual(lines);
});

test("cleanLines: cap elides the middle past MAX when enabled", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const out = cleanLines(lines, { command: "echo", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(out.length).toBeLessThan(200);
    expect(out.some((line) => /lines elided/.test(line))).toBe(true);
});

/* A line is not a unit of size. `grep -rn --include=*.css` over minified CSS returns sixty lines and 130 KB, and
 * the line cap never looked at it — 8.2% of one ledger window's entire raw volume arrived this way. */
test("cleanLines: cap trims long-line output that never reaches the line limit", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/a${i}.css:1:${"x".repeat(2000)}`);
    const out = cleanLines(lines, { command: "grep -rn x --include=*.css .", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(lines.length).toBeLessThan(100);
    expect(out.length).toBeLessThan(lines.length);
    expect(out.join("\n").length).toBeLessThan(20_000);
    expect(out.some((line) => line.includes("lines elided"))).toBe(true);
});

test("cleanLines: a read gets a far larger byte budget than a log, and keeps its head", () => {
    // ~60 KB: over the log budget, under the read budget. The same bytes are capped as a log and kept as a read.
    const lines = Array.from({ length: 30 }, (_, i) => `${i}: ${"x".repeat(2000)}`);
    expect(cleanLines(lines, { command: "cat big.json", exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(30);
    expect(cleanLines(lines, { command: "curl -s http://api/x", exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(30);
    // Past the read budget it is trimmed from the END, where a file read naturally stops.
    const huge = Array.from({ length: 60 }, (_, i) => `${i}: ${"x".repeat(2000)}`);
    const capped = cleanLines(huge, { command: "cat big.json", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(capped[0]).toBe(huge[0]);
    expect(capped.at(-1)).toContain("use the Read tool");
});

test("cleanLines: a single line over the whole budget is truncated rather than dropped for a marker", () => {
    const out = cleanLines([`{"data":"${"x".repeat(40_000)}"}`], {
        command: "curl -s http://api/x",
        exitCode: "0",
        enabled: new Set(CLEANERS),
    }).lines;
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("line truncated at");
    expect(out[0].length).toBeLessThan(20_000);
});

// `git --no-pager diff` is the form this workspace's own instructions ask for; read as a log it had its middle
// gutted — a 274-line diffstat came back as 81 lines.
test("cleanLines: git global options before the verb still read as a deliberate read", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `+ line ${i}`);
    for (const command of ["git --no-pager diff --stat", "git -c core.pager=cat diff", "git --no-pager show HEAD"]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(300);
    }
    // …and a plain `git log` is still history, not a read.
    expect(cleanLines(lines, { command: "git --no-pager log --oneline", exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(100);
});

test("cleanLines: cap disabled keeps all lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("-cap") }).lines).toHaveLength(200);
});

// A read is the one shape where the middle is the point. Capping it at 100 made `cat` strictly worse than the
// Read tool, and the model paid for the file twice.
test("cleanLines: a deliberate read is not capped at MAX, even behind a `cd … &&` prefix", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const command of ["cd /work/intentic && cat src/app.ts", "sed -n '40,600p' src/app.ts", "git diff src/app.ts"]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(400);
    }
});

/* What production hands `cleanLines` is the LAUNCHER line, not the shell statement — and every test above this
 * one passed the shell statement, which is how a read detector that never fired on a bare `cat` survived. One
 * day of real commands: 88 of 93 shell reads misread as logs, five gutted reads of the workspace README. */
const WRAPPED = (inner) => `nsenter --mount=/proc/1/ns/mnt --wd=WORKSPACE_ROOT -- nice -n 10 ionice -c 2 -n 7 bash -c '${inner}'`;

test("cleanLines: a read is recognised through the nsenter/bash -c wrapper, with or without a `cd` prefix", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const inner of ["cat /work/README.md", "sed -n 1,400p src/app.ts", "cd /work/intentic && cat src/app.ts", "git show HEAD -- src/app.ts"]) {
        expect(cleanLines(lines, { command: WRAPPED(inner), exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(400);
    }
});

test("cleanLines: a log is still capped through the wrapper — `cat` in a word is not the `cat` command", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const inner of ["pnpm install --concat-logs", "cd /work && ls -R", "git log --oneline -400"]) {
        expect(cleanLines(lines, { command: WRAPPED(inner), exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(100);
    }
});

test("cleanLines: a read past READ_MAX is trimmed from the end, not the middle", () => {
    const lines = Array.from({ length: 2400 }, (_, i) => `line ${i}`);
    const out = cleanLines(lines, { command: "cat big.ts", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(out).toHaveLength(2001);
    expect(out[1999]).toBe("line 1999");
    expect(out.at(-1)).toContain("400 more lines elided");
});

test("cleanLines: a log-shaped command is still capped at MAX", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const command of ["pnpm install", "git log --oneline -400", "cd /work && ls -R"]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(100);
    }
});

test("filterOutput: strips ANSI and appends a footer with the handle when the trim is big enough to retrieve", () => {
    const raw = `${[...Array.from({ length: 30 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`), "\x1b[32mdone\x1b[0m"].join("\n")}\n`;
    const out = filterOutput(raw, "pnpm install", "0", "1", "/logs/x.log").out;
    expect(out).toContain("done");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("retrieve-output /logs/x.log");
});

/* The two halves of the footer are priced separately because they are worth different things. Nobody retrieves
 * three elided lines of progress noise — across 10,446 agent commands the handle was followed zero times — but
 * "you are not looking at all of it" is what stops a trimmed result being read as a complete one. */
test("filterOutput: a small trim keeps the counts and drops the retrieval handle", () => {
    const raw = `${[...Array.from({ length: 4 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`), "done"].join("\n")}\n`;
    const out = filterOutput(raw, "pnpm install", "0", "1", "/logs/x.log").out;
    expect(out).toContain("5 lines filtered to 1");
    expect(out).not.toContain("retrieve-output");
});

test("filterOutput: a trim smaller than the footer it would buy keeps the trim and drops the footer", () => {
    // One `total 48` header is ten bytes. Buying anything with it is how `ls` came to hand back MORE than it
    // was given — the never-worse rule, which sits behind the handle gate and is not replaced by it.
    const raw = "total 48\n-rw-r--r--  1 root root  3801 Jul 30 13:38 a.ts\n";
    const out = filterOutput(raw, "ls -la", "0", "1", "/logs/x.log").out;
    expect(out.length).toBeLessThanOrEqual(raw.length);
    expect(out).toContain("644 a.ts  3.7K");
    expect(out).not.toContain("retrieve-output");
});

test("filterOutput: never emits more than it was given", () => {
    // The total backstop behind the footer rule: whatever a cleaner does, a result that grew is not a result.
    for (const raw of ["x\n", "total 0\n", "a\nb\n", "(no notable output)\n"]) {
        expect(filterOutput(raw, "ls -la /empty", "0", "1", "/logs/x.log").out.length).toBeLessThanOrEqual(raw.length);
    }
});

test("filterOutput: no footer when nothing was dropped", () => {
    expect(filterOutput("hello\nworld\n", "echo hi", "0", "0", "").out).toBe("hello\nworld\n");
});

test("test cleaner: drops per-test pass lines on green, keeps the summary", () => {
    const lines = ["✓ src/a.test.ts (3)", "✓ src/b.test.ts (2)", "Test Files  2 passed (2)", "Tests  5 passed (5)"];
    const out = cleanLines(lines, { command: "vitest run", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(out).toEqual(["Test Files  2 passed (2)", "Tests  5 passed (5)"]);
});

test("test cleaner: a failing run keeps everything (command cleaners skip on non-zero exit)", () => {
    const lines = ["✓ src/a.test.ts (3)", "FAIL src/b.test.ts", "AssertionError: expected 1 to be 2"];
    expect(cleanLines(lines, { command: "vitest run", exitCode: "1", enabled: new Set(CLEANERS) }).lines).toEqual(lines);
});

test("dedup: collapses a run of >=3 identical lines with a count", () => {
    const lines = ["warn: retry", "warn: retry", "warn: retry", "warn: retry", "done"];
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("dedup") }).lines).toEqual([
        "warn: retry",
        "  … (3 more identical lines)",
        "done",
    ]);
});

test("dedup: leaves distinct lines and short runs untouched", () => {
    const lines = ["a", "b", "b", "c"];
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("dedup") }).lines).toEqual(lines);
});

const redacted = (lines, exitCode = "0") => cleanLines(lines, { command: "env", exitCode, enabled: parseCleaners("redact") }).lines;

test("redact: masks secret-named assignments, AWS keys, and bearer tokens on success and failure", () => {
    const lines = ["export GITHUB_TOKEN=ghp_abcd1234", "key AKIAIOSFODNN7EXAMPLE end", "Authorization: Bearer sk-xyz.123"];
    expect(redacted(lines)).toEqual(["export GITHUB_TOKEN=***", "key *** end", "Authorization: Bearer ***"]);
    expect(redacted(["boom TOKEN=sk-ant-api03-9f2"], "1")).toEqual(["boom TOKEN=***"]);
});

const maskedWith = (values, lines) => cleanLines(lines, { command: "cat config", exitCode: "0", enabled: parseCleaners("redact"), values }).lines;

/* THE NAME HEURISTIC'S FLOOR, and what value-masking is for. Every field name below is one the capability
 * union itself declares secret, and none of them says token/secret/password/api-key — so the pattern half
 * cannot see them, however it is extended. Measured against the six declared shapes, five went through. */
test("redact: field names the pattern list cannot know leak without the values, and are masked with them", () => {
    const lines = [
        `"presharedKey": "K7mNp2qR8tVw3xYz5aBc"`,
        `"seed": "JBSWY3DPEHPK3PXPABCDEF"`,
        `"pat": "Q8rTv2WxYz5aBc7dEf9g"`,
        `"config": "wg-conf-body-8xY3zQ1mNp"`,
    ];
    // Without the values, the names carry no signal and the lines pass through whole.
    expect(maskedWith([], lines)).toEqual(lines);
    const values = ["K7mNp2qR8tVw3xYz5aBc", "JBSWY3DPEHPK3PXPABCDEF", "Q8rTv2WxYz5aBc7dEf9g", "wg-conf-body-8xY3zQ1mNp"];
    expect(maskedWith(values, lines)).toEqual([`"presharedKey": "***"`, `"seed": "***"`, `"pat": "***"`, `"config": "***"`]);
});

test("redact: a value is masked wherever it appears, not only beside a name", () => {
    const values = ["K7mNp2qR8tVw3xYz5aBc"];
    expect(maskedWith(values, ["curl -H 'X-Custom: K7mNp2qR8tVw3xYz5aBc' https://api"])).toEqual(["curl -H 'X-Custom: ***' https://api"]);
    // Twice on one line, and mid-word, because a credential pasted into a URL is still the credential.
    expect(maskedWith(values, ["a=K7mNp2qR8tVw3xYz5aBc&b=K7mNp2qR8tVw3xYz5aBc"])).toEqual(["a=***&b=***"]);
});

test("redact: ordinary output is untouched by value masking", () => {
    const lines = ["Compiled 42 modules in 1.2s", "ordinary prose about a token", "path/to/file.ts:12"];
    expect(maskedWith(["K7mNp2qR8tVw3xYz5aBc"], lines)).toEqual(lines);
});

test("redact: a quoted value is masked whole, and the quotes survive so the line still parses", () => {
    expect(redacted([`const key = { apiKey: "sk-ant-api03-9f2Kd" };`])).toEqual([`const key = { apiKey: "***" };`]);
    expect(redacted(["password: 'hunter2hunter2'"])).toEqual(["password: '***'"]);
});

/* The second regression, measured the same way as the first: over one day the redactor masked 182 lines a model
 * then had to work from and caught zero secrets. Every case here was observed, not imagined.
 *
 * The token COUNTS are the ones that bite hardest — this workspace's own spend ledger is JSON full of fields
 * named `…Tokens`, so masking them both destroys the number and breaks the parse for whatever reads it next.
 * Note `outputTokens` beside `cacheReadTokens`: under the old six-character floor the mask fired as a function
 * of MAGNITUDE, which is why it passed every small test and only failed on real data. */
test("redact: a number is never a credential, however secret-shaped the field name is", () => {
    const numbers = [
        `{"conversationId":"x","cacheReadTokens":26170149,"cacheCreationTokens":27967}`,
        `  "outputTokens": 94746,`,
        `  readonly inputTokens: 1234567;`,
        `contextTokens: 200_000`,
        `  maxTokens: 200000`,
        `node --max-tokens=131072 run.js`,
        `expect(turn.outputTokens).toBe(1048576)`,
    ];
    expect(redacted(numbers)).toEqual(numbers);
});

// What length alone cannot tell apart: the long values in this repo are paths, template interpolations and the
// NAMES of variables. A generated credential is none of those.
test("redact: a path, a template interpolation or an env-var name is not a credential at any length", () => {
    const structural = [
        `const tokenPath = "/run/intentic/agent.token";`,
        "runnerToken: `${STATE_DIR}/runner-token`,",
        `password: "INTENTIC_FORGEJO_ADMIN_PASSWORD"`,
        `token: "intentic-translator-local"`,
        `apiKey: "tok-abc-123"`,
        `const secret = "test-secret";`,
    ];
    expect(redacted(structural)).toEqual(structural);
});

test("redact: still takes a real credential — by issuer prefix at any length, or by entropy and length", () => {
    expect(redacted([`ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij`])).toEqual(["ANTHROPIC_API_KEY=***"]);
    expect(redacted([`SLACK_TOKEN=xoxb-1234-5678-abcdefghij`])).toEqual(["SLACK_TOKEN=***"]);
    expect(redacted([`API_KEY="a1b2c3d4e5f6g7h8i9j0k1"`])).toEqual([`API_KEY="***"`]);
});

// The regression this rule exists for: source code says "token" constantly, and every one of these reached a
// model corrupted — `=***` is indistinguishable from `!==`, and a masked type annotation loses the type.
test("redact: leaves source code alone — comparisons, type annotations, property access and calls", () => {
    const code = [
        `if (oauthToken === undefined && services.config.claudeCodeOauthToken === "") {`,
        `let oauthToken: string | undefined;`,
        `oauthToken = await ensureFreshToken(services.claudeStore, accountId);`,
        `const token = (await rl.question("Bridge token (ibt_…): ")).trim();`,
        `inputTokens: usage.inputTokens ?? 0,`,
        `const tokensDelta = computed(() => deltaPercent(totalTokens(totals.value)));`,
        `const rankFor = (entry: PickerEntry, tokens: readonly string[]): number => {`,
        `export const CapabilitySecretInputSchema = z.object({ id: z.string() });`,
        `// An auth stub that refuses every bearer token, proving the route's gate`,
    ];
    expect(redacted(code)).toEqual(code);
});

// --- shape cleaners: gated by the OUTPUT, so `cd x && …` (four out of five agent commands) still reaches them.

test("ls cleaner: rewrites long-listing entries to mode/name/size and drops the header and dot entries", () => {
    const lines = [
        "total 24",
        "drwxr-xr-x  2 root root  4096 Jul 30 13:38 .",
        "drwxr-xr-x 41 root root  4096 Jul 30 13:38 ..",
        "drwxr-xr-x  2 root root  4096 Jul 30 13:38 agent",
        "-rw-r--r--  1 root root  3801 Jul 30 13:38 agent-commands.ts",
        "-rwxr-xr-x  1 root root  1234 Dec 25  2024 build.sh",
        "lrwxrwxrwx  1 root root     7 Jul 30 13:38 latest -> agent.ts",
    ];
    expect(cleanLines(lines, { command: "cd /work && ls -la src", exitCode: "0", enabled: parseCleaners("ls") }).lines).toEqual([
        "755 agent/",
        "644 agent-commands.ts  3.7K",
        "755 build.sh  1.2K",
        "777 latest -> agent.ts  7B",
    ]);
});

test("ls cleaner: an owner or group containing a space still parses (the date is the anchor, not a column)", () => {
    const lines = ["-rw-r--r--  1 fjeanne utilisa. du domaine 1234 Mar 31 16:18 data.json"];
    expect(cleanLines(lines, { command: "ls -l", exitCode: "0", enabled: parseCleaners("ls") }).lines).toEqual(["644 data.json  1.2K"]);
});

test("ls cleaner: output it cannot parse is handed back untouched (a non-English locale must not vanish)", () => {
    const lines = ["total 8", "drwxr-xr-x  2 user user  4096  1月  1 12:00 src", "-rw-r--r--  1 user user 1234  1月  1 12:00 main.rs"];
    expect(cleanLines(lines, { command: "ls -la", exitCode: "0", enabled: parseCleaners("ls") }).lines).toEqual(lines);
});

test("files cleaner: folds a run of bare paths by directory, keeping every name and saying the root once", () => {
    const lines = [
        ...Array.from({ length: 6 }, (_, i) => `/work/src/agent/mod-${i}.ts`),
        ...Array.from({ length: 6 }, (_, i) => `/work/src/logs/mod-${i}.ts`),
    ];
    const out = cleanLines(lines, { command: "cd /work && find . -name '*.ts'", exitCode: "0", enabled: parseCleaners("files") }).lines;
    expect(out).toEqual([
        "12 paths in 2 directories under /work/src/:",
        "agent/ mod-0.ts mod-1.ts mod-2.ts mod-3.ts mod-4.ts mod-5.ts",
        "logs/ mod-0.ts mod-1.ts mod-2.ts mod-3.ts mod-4.ts mod-5.ts",
    ]);
});

test("files cleaner: leaves short runs, grep diagnostics and word lists alone", () => {
    const short = ["a/one.ts", "a/two.ts", "a/three.ts"];
    expect(cleanLines(short, { command: "find .", exitCode: "0", enabled: parseCleaners("files") }).lines).toEqual(short);
    // `path:line:` is a diagnostic, not a path — folding it would destroy the line numbers it exists to carry.
    const grep = Array.from({ length: 20 }, (_, i) => `src/mod.ts:${i}:import x`);
    expect(cleanLines(grep, { command: "grep -rn import src", exitCode: "0", enabled: parseCleaners("files") }).lines).toEqual(grep);
    const words = Array.from({ length: 20 }, (_, i) => `package-${i}`);
    expect(cleanLines(words, { command: "ls", exitCode: "0", enabled: parseCleaners("files") }).lines).toEqual(words);
});

test("files cleaner: a run mixing absolute and relative paths shares no root and still terminates", () => {
    const lines = [...Array.from({ length: 6 }, (_, i) => `/abs/dir/f-${i}.ts`), ...Array.from({ length: 6 }, (_, i) => `rel/dir/f-${i}.ts`)];
    const out = cleanLines(lines, { command: "find .", exitCode: "0", enabled: parseCleaners("files") }).lines;
    expect(out[0]).toBe("12 paths in 2 directories:");
    expect(out).toHaveLength(3);
});

test("sessionKeyFromLog: recovers the agent session name from a per-command pane-log path", () => {
    expect(sessionKeyFromLog("/logs/terminals/agent-abcd1234-%5.log")).toBe("agent-abcd1234");
    expect(sessionKeyFromLog("")).toBeUndefined();
    expect(sessionKeyFromLog(undefined)).toBeUndefined();
});

// Every body here has to clear CACHE_MIN_BYTES, because below it the collapse is (correctly) declined. Sized
// fixtures rather than short strings: a marker is ~130 bytes before it names anything, so a fixture the cache
// would never collapse in production is a fixture that proves nothing about the cache.
const body = (label) => `${label}: ${"x".repeat(600)}`;

test("collapseCached: first run records and passes through, an identical repeat collapses to the marker", () => {
    const store = memoryStore();
    const first = collapseCached(body("git status output"), "git status", store, "/logs/x.log");
    expect(first).toEqual({ body: body("git status output"), cached: false });
    const second = collapseCached(body("git status output"), "git status", store, "/logs/x.log");
    expect(second.cached).toBe(true);
    expect(second.body).toContain(CACHE_MARKER);
    expect(second.body).toContain("retrieve-output /logs/x.log");
});

test("collapseCached: different output for the same command is not a hit", () => {
    const store = memoryStore();
    collapseCached(body("first"), "date", store, "");
    expect(collapseCached(body("second"), "date", store, "").cached).toBe(false);
});

/* The floor is what keeps the collapse honest, in bytes AND in meaning. A four-byte "OK" traded for a 400-byte
 * pointer is a result made worse; and short bodies COLLIDE across unrelated commands, which is how a
 * desktop-install verification once came back named as the output of `sleep 90; cat /tmp/smoke-run1.log`. */
test("collapseCached: a body under the floor is never collapsed, and is never recorded as a back-reference", () => {
    const store = memoryStore();
    expect(collapseCached("OK", "verify-install.sh", store, "/logs/x.log").cached).toBe(false);
    expect(collapseCached("OK", "verify-install.sh", store, "/logs/x.log").cached).toBe(false);
    // …and it cannot be named as the earlier producer for some other command that happens to print "OK" too.
    expect(collapseCached("OK", "sleep 90; cat /tmp/smoke-run1.log", store, "").body).toBe("OK");
});

test("collapseCached: an identical body from a DIFFERENT command collapses, naming the command that produced it", () => {
    const store = memoryStore();
    collapseCached(body("the file contents"), "cat src/a.ts", store, "/logs/x.log");
    const second = collapseCached(body("the file contents"), "sed -n '1,50p' src/a.ts", store, "/logs/x.log");
    expect(second.cached).toBe(true);
    expect(second.body).toContain(CACHE_MARKER);
    expect(second.body).toContain("`cat src/a.ts`");
});

// A long earlier command would balloon the very marker that is supposed to be small.
test("collapseCached: the named command is truncated so the marker stays cheap", () => {
    const store = memoryStore();
    const long = `cd /work/intentic && ${"./node_modules/.bin/vitest run src/very/long/path ".repeat(6)}`;
    collapseCached(body("suite"), long, store, "");
    const second = collapseCached(body("suite"), "pnpm test", store, "");
    expect(second.body).toContain("…");
    expect(second.body.length).toBeLessThan(300);
});

// The back-reference must point at the FIRST producer, not the most recent one — a pointer that keeps walking
// toward the reader eventually names the call directly above and stops being worth following.
test("collapseCached: the back-reference keeps naming the earliest command, not the latest", () => {
    const store = memoryStore();
    collapseCached(body("same"), "first-cmd", store, "");
    collapseCached(body("same"), "second-cmd", store, "");
    expect(collapseCached(body("same"), "third-cmd", store, "").body).toContain("`first-cmd`");
});

test("collapseCached: a body seen only under this same command still reads as a repeat, not a cross-reference", () => {
    const store = memoryStore();
    collapseCached(body("out"), "ls", store, "");
    expect(collapseCached(body("out"), "ls", store, "").body).toContain("a previous run this session");
});

test("filterOutput: cache collapses a byte-identical success repeat, and is a no-op without a store", () => {
    const store = memoryStore();
    // Over CACHE_MIN_BYTES, or the collapse is declined before the never-worse guard is even consulted.
    const raw = `${Array.from({ length: 20 }, (_, i) => `branch-${i} is up to date with origin/main and tracking it cleanly`).join("\n")}\n`;
    expect(filterOutput(raw, "git branch -vv", "0", "0", "", new Set(CLEANERS), store).out).toBe(raw);
    const repeat = filterOutput(raw, "git branch -vv", "0", "0", "/logs/y.log", new Set(CLEANERS), store).out;
    expect(repeat).toContain(CACHE_MARKER);
    // Without a store the same input passes through unchanged (deterministic for the offline bench).
    expect(filterOutput(raw, "git branch -vv", "0", "0", "").out).toBe(raw);
});

test("filterOutput: a repeat too short to pay for the collapse marker is left alone", () => {
    const store = memoryStore();
    const raw = "hello\nworld\n";
    filterOutput(raw, "echo hi", "0", "0", "/logs/y.log", new Set(CLEANERS), store);
    expect(filterOutput(raw, "echo hi", "0", "0", "/logs/y.log", new Set(CLEANERS), store).out).toBe(raw);
});

test("filterOutput: cache disabled leaves a repeat untouched", () => {
    const store = memoryStore();
    const raw = `${Array.from({ length: 20 }, (_, i) => `branch-${i} is up to date with origin/main and tracking it cleanly`).join("\n")}\n`;
    filterOutput(raw, "git branch -vv", "0", "0", "", parseCleaners("-cache"), store);
    expect(filterOutput(raw, "git branch -vv", "0", "0", "", parseCleaners("-cache"), store).out).toBe(raw);
});
