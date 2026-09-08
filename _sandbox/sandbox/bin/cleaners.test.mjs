import { expect, test } from "vitest";
import { filterOutput } from "./agent-output-filter.mjs";
import { CACHE_MARKER, CLEANERS, cleanLines, collapseCached, matchedCleaners, parseCleaners, sessionKeyFromLog } from "./cleaners.mjs";


// In-memory stand-in for the file-backed cache store, for deterministic tests with no disk access.
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
    expect(parseCleaners("nonsense")).toEqual(new Set(CLEANERS));
    expect(parseCleaners("test,bogus")).toEqual(new Set(["test"]));
    // `git` is a retired cleaner id; unknown tokens degrade to the allow-list, not a crash.
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

test("cleanLines: cap trims long-line output that never reaches the line limit", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `src/a${i}.css:1:${"x".repeat(2000)}`);
    const out = cleanLines(lines, { command: "grep -rn x --include=*.css .", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(lines.length).toBeLessThan(100);
    expect(out.length).toBeLessThan(lines.length);
    expect(out.join("\n").length).toBeLessThan(20_000);
    expect(out.some((line) => line.includes("lines elided"))).toBe(true);
});

test("cleanLines: a read gets a far larger byte budget than a log, and keeps its head", () => {
    // 60 KB clears the log budget but stays under the read budget; same bytes, capped as a log, kept as a read.
    const lines = Array.from({ length: 30 }, (_, i) => `${i}: ${"x".repeat(2000)}`);
    expect(cleanLines(lines, { command: "cat big.json", exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(30);
    expect(cleanLines(lines, { command: "curl -s http://api/x", exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(30);
    // Past the read budget, output is trimmed from the end, where a file read naturally stops.
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

test("cleanLines: git global options before the verb still read as a deliberate read", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `+ line ${i}`);
    for (const command of ["git --no-pager diff --stat", "git -c core.pager=cat diff", "git --no-pager show HEAD"]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(300);
    }
    // A plain `git log` is still history, not a read.
    expect(cleanLines(lines, { command: "git --no-pager log --oneline", exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(100);
});

// Some git options take their value as a separate word (`-C <path>`); a naive skip must not stop at the value before it
// reaches the verb.
test("cleanLines: a git option that takes a separate value still reads as a deliberate read", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `+ line ${i}`);
    for (const command of [
        "git -C /history/worktrees/mellow-moth/intentic diff -- _sandbox",
        "git -C /repo show HEAD:src/app.ts",
        "git --git-dir /repo/.git --work-tree /repo diff",
        "git -C /repo log -p -- src/app.ts",
    ]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(300);
    }
    // The value is skipped, not swallowed: `log` without `-p` stays a log no matter what precedes it.
    expect(cleanLines(lines, { command: "git -C /repo log --oneline", exitCode: "0", enabled: new Set(CLEANERS) }).lines.length).toBeLessThan(100);
});

test("cleanLines: cap disabled keeps all lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    expect(cleanLines(lines, { command: "echo", exitCode: "0", enabled: parseCleaners("-cap") }).lines).toHaveLength(200);
});

test("cleanLines: a deliberate read is not capped at MAX, even behind a `cd … &&` prefix", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const command of ["cd /work/intentic && cat src/app.ts", "sed -n '40,600p' src/app.ts", "git diff src/app.ts"]) {
        expect(cleanLines(lines, { command, exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(400);
    }
});

// Production passes `cleanLines` the launcher line, not the shell statement.
const WRAPPED = (inner) => `nsenter --mount=/proc/1/ns/mnt --wd=WORKSPACE_ROOT -- nice -n 10 ionice -c 2 -n 7 bash -c '${inner}'`;

test("cleanLines: a read is recognised through the nsenter/bash -c wrapper, with or without a `cd` prefix", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (const inner of ["cat /work/README.md", "sed -n 1,400p src/app.ts", "cd /work/intentic && cat src/app.ts", "git show HEAD -- src/app.ts"]) {
        expect(cleanLines(lines, { command: WRAPPED(inner), exitCode: "0", enabled: new Set(CLEANERS) }).lines).toHaveLength(400);
    }
});

test("cleanLines: a log is still capped through the wrapper, `cat` in a word is not the `cat` command", () => {
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

test("filterOutput: a small trim keeps the counts and drops the retrieval handle", () => {
    const raw = `${[...Array.from({ length: 4 }, (_, i) => `Progress: resolved ${i}00, reused ${i}00, downloaded 0, added 0`), "done"].join("\n")}\n`;
    const out = filterOutput(raw, "pnpm install", "0", "1", "/logs/x.log").out;
    expect(out).toContain("5 lines filtered to 1");
    expect(out).not.toContain("retrieve-output");
});

test("filterOutput: a trim smaller than the footer it would buy keeps the trim and drops the footer", () => {
    // The never-worse rule sits behind the handle gate, not replaced by it: a result must never grow.
    const raw = "total 48\n-rw-r--r--  1 root root  3801 Jul 30 13:38 a.ts\n";
    const out = filterOutput(raw, "ls -la", "0", "1", "/logs/x.log").out;
    expect(out.length).toBeLessThanOrEqual(raw.length);
    expect(out).toContain("644 a.ts  3.7K");
    expect(out).not.toContain("retrieve-output");
});

test("filterOutput: never emits more than it was given", () => {
    for (const raw of ["x\n", "total 0\n", "a\nb\n", "(no notable output)\n"]) {
        expect(filterOutput(raw, "ls -la /empty", "0", "1", "/logs/x.log").out.length).toBeLessThanOrEqual(raw.length);
    }
});

test("filterOutput: no footer when nothing was dropped", () => {
    expect(filterOutput("hello\nworld\n", "echo hi", "0", "0", "").out).toBe("hello\nworld\n");
});

test("cleaner: drops per-test pass lines on green, keeps the summary", () => {
    const lines = ["✓ src/a.test.ts (3)", "✓ src/b.test.ts (2)", "Test Files  2 passed (2)", "Tests  5 passed (5)"];
    const out = cleanLines(lines, { command: "vitest run", exitCode: "0", enabled: new Set(CLEANERS) }).lines;
    expect(out).toEqual(["Test Files  2 passed (2)", "Tests  5 passed (5)"]);
});

test("a stripper claims the command, not a filename that contains its name", () => {
    const enabled = new Set(CLEANERS);
    for (const command of [
        "cd /work && rg -n foo node_modules/.pnpm/@cursor+sdk/dist",
        "git diff --stat -- ':!pnpm-lock.yaml'",
        "cat _editor/web/vitest.setup.ts",
        "cd /work && ls _sandbox/src/peers/peer-routes.test.ts",
        "cat scripts/adapt.sh",
    ]) {
        expect(matchedCleaners(command, enabled)).toEqual([]);
    }
    // Invocations themselves are still claimed, quoted by the launcher or behind a `cd … &&`.
    expect(matchedCleaners("pnpm install", enabled)).toEqual(["pnpm"]);
    expect(matchedCleaners("cd /work/intentic && pnpm build", enabled)).toEqual(["pnpm"]);
    expect(matchedCleaners(WRAPPED("timeout 900 npx vitest run src/agents"), enabled)).toEqual(["test"]);
    expect(matchedCleaners("cargo test --release", enabled)).toEqual(["test"]);
    expect(matchedCleaners("sudo apt-get install -y jq", enabled)).toEqual(["apt"]);
});

test("a stripper that no longer claims a command leaves its output entirely alone", () => {
    // `PASS`/`✓` lines inside a listing are content; only a real test run may drop them.
    const lines = ["✓ src/a.test.ts (4)", "PASS src/b.test.ts", "M  src/c.test.ts"];
    expect(cleanLines(lines, { command: "cat notes/vitest.md", exitCode: "0", enabled: new Set(CLEANERS) }).lines).toEqual(lines);
});

test("cleaner: a failing run keeps everything (command cleaners skip on non-zero exit)", () => {
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

// None of these field names match token/secret/password/api-key, so only value-masking catches them; a known value
// masks to its `{{secret:name}}` reference.
test("redact: field names the pattern list cannot know leak without the values, and are masked with them", () => {
    const lines = [
        `"presharedKey": "K7mNp2qR8tVw3xYz5aBc"`,
        `"seed": "JBSWY3DPEHPK3PXPABCDEF"`,
        `"pat": "Q8rTv2WxYz5aBc7dEf9g"`,
        `"config": "wg-conf-body-8xY3zQ1mNp"`,
    ];
    // Without the values, the names carry no signal and the lines pass through unchanged.
    expect(maskedWith([], lines)).toEqual(lines);
    const values = [
        { target: "K7mNp2qR8tVw3xYz5aBc", replacement: "{{secret:vpnbox/presharedKey}}" },
        { target: "JBSWY3DPEHPK3PXPABCDEF", replacement: "{{secret:otp/seed}}" },
        { target: "Q8rTv2WxYz5aBc7dEf9g", replacement: "{{secret:forge/pat}}" },
        { target: "wg-conf-body-8xY3zQ1mNp", replacement: "{{secret:vpnbox/config}}" },
    ];
    expect(maskedWith(values, lines)).toEqual([
        `"presharedKey": "{{secret:vpnbox/presharedKey}}"`,
        `"seed": "{{secret:otp/seed}}"`,
        `"pat": "{{secret:forge/pat}}"`,
        `"config": "{{secret:vpnbox/config}}"`,
    ]);
});

test("redact: a value is masked wherever it appears, not only beside a name", () => {
    const values = [{ target: "K7mNp2qR8tVw3xYz5aBc", replacement: "{{secret:vpnbox/presharedKey}}" }];
    expect(maskedWith(values, ["curl -H 'X-Custom: K7mNp2qR8tVw3xYz5aBc' https://api"])).toEqual([
        "curl -H 'X-Custom: {{secret:vpnbox/presharedKey}}' https://api",
    ]);
    // Masked twice on one line, and mid-word: wherever the value appears, not just beside a name.
    expect(maskedWith(values, ["a=K7mNp2qR8tVw3xYz5aBc&b=K7mNp2qR8tVw3xYz5aBc"])).toEqual([
        "a={{secret:vpnbox/presharedKey}}&b={{secret:vpnbox/presharedKey}}",
    ]);
});

test("redact: ordinary output is untouched by value masking", () => {
    const lines = ["Compiled 42 modules in 1.2s", "ordinary prose about a token", "path/to/file.ts:12"];
    expect(maskedWith([{ target: "K7mNp2qR8tVw3xYz5aBc", replacement: "{{secret:vpnbox/presharedKey}}" }], lines)).toEqual(lines);
});

test("redact: a quoted value is masked whole, and the quotes survive so the line still parses", () => {
    expect(redacted([`const key = { apiKey: "sk-ant-api03-9f2Kd" };`])).toEqual([`const key = { apiKey: "***" };`]);
    expect(redacted(["password: 'hunter2hunter2'"])).toEqual(["password: '***'"]);
});

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

test("redact: still takes a real credential, by issuer prefix at any length, or by entropy and length", () => {
    expect(redacted([`ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij`])).toEqual(["ANTHROPIC_API_KEY=***"]);
    expect(redacted([`SLACK_TOKEN=xoxb-1234-5678-abcdefghij`])).toEqual(["SLACK_TOKEN=***"]);
    expect(redacted([`API_KEY="a1b2c3d4e5f6g7h8i9j0k1"`])).toEqual([`API_KEY="***"`]);
});

// Masking source code would break it: `=***` reads as `!==`, and a masked type annotation loses the type.
test("redact: leaves source code alone, comparisons, type annotations, property access and calls", () => {
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

// Shape cleaners below are gated by the output, not the command prefix; `cd x && …` still reaches them.

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
    // `path:line:` is a diagnostic, not a path; folding it would destroy the line numbers it carries.
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

test("hits cleaner: says each file once and indents its later hits, keeping every line and number", () => {
    const lines = [
        "_editor/web/src/composables/workspace/commitMessage.ts:92:export const fillCommitMessage = (",
        "_editor/web/src/composables/workspace/commitMessage.ts:103:export const clearFilledMessage = (",
        "_editor/web/src/composables/workspace/commitMessage.ts:126:export const followFilledMessage = (",
        "_editor/web/src/composables/workspace/changeOrigins.ts:93:type MessageCarrier = {",
        "_editor/web/src/composables/workspace/changeOrigins.ts:110:export const landedMessage = (",
        "_editor/web/src/composables/workspace/changeOrigins.ts:111:    card?.landedMessage",
    ];
    expect(cleanLines(lines, { command: "rg -n message _editor", exitCode: "0", enabled: parseCleaners("hits") }).lines).toEqual([
        "_editor/web/src/composables/workspace/commitMessage.ts:92:export const fillCommitMessage = (",
        "  103:export const clearFilledMessage = (",
        "  126:export const followFilledMessage = (",
        "_editor/web/src/composables/workspace/changeOrigins.ts:93:type MessageCarrier = {",
        "  110:export const landedMessage = (",
        "  111:    card?.landedMessage",
    ]);
});

test("hits cleaner: a column number survives, and one hit per file is left as it came", () => {
    const withColumn = Array.from({ length: 6 }, (_, i) => `src/deep/module.ts:${10 + i}:4:const value${i} = ${i};`);
    const out = cleanLines(withColumn, { command: "rg -n --column value src", exitCode: "0", enabled: parseCleaners("hits") }).lines;
    expect(out[0]).toBe("src/deep/module.ts:10:4:const value0 = 0;");
    expect(out[1]).toBe("  11:4:const value1 = 1;");
    // Six distinct files fold to exactly what they replaced, so no fold is taken.
    const scattered = Array.from({ length: 6 }, (_, i) => `src/mod-${i}.ts:${i}:import x`);
    expect(cleanLines(scattered, { command: "rg -n import src", exitCode: "0", enabled: parseCleaners("hits") }).lines).toEqual(scattered);
});

test("hits cleaner: leaves short runs, timestamps and non-hit text alone", () => {
    const short = Array.from({ length: 5 }, (_, i) => `src/a.ts:${i}:x`);
    expect(cleanLines(short, { command: "rg -n x src", exitCode: "0", enabled: parseCleaners("hits") }).lines).toEqual(short);
    // `12:34:56` and `Note:12:00` parse as `path:line:` too but are not hits: the key must be a filename.
    const stamps = Array.from({ length: 12 }, (_, i) => `12:3${i % 10}:00 started worker ${i}`);
    expect(cleanLines(stamps, { command: "cat run.log", exitCode: "0", enabled: parseCleaners("hits") }).lines).toEqual(stamps);
});

test("hits cleaner: never reorders, so a file whose hits are interleaved keeps its line order", () => {
    const lines = ["a/x.ts:1:one", "a/x.ts:2:two", "b/y.ts:3:three", "a/x.ts:4:four", "a/x.ts:5:five", "b/y.ts:6:six"];
    const out = cleanLines(lines, { command: "rg -n . a b", exitCode: "0", enabled: parseCleaners("hits") }).lines;
    expect(out).toEqual(["a/x.ts:1:one", "  2:two", "b/y.ts:3:three", "a/x.ts:4:four", "  5:five", "b/y.ts:6:six"]);
});

test("sessionKeyFromLog: recovers the agent session name from a per-command pane-log path", () => {
    expect(sessionKeyFromLog("/logs/terminals/agent-abcd1234-%5.log")).toBe("agent-abcd1234");
    expect(sessionKeyFromLog("")).toBeUndefined();
    expect(sessionKeyFromLog(undefined)).toBeUndefined();
});

// Bodies must clear CACHE_MIN_BYTES: the marker itself is ~130 bytes, so a smaller fixture proves nothing.
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

// The floor also stops short bodies colliding across unrelated commands, and stops a small result being replaced by a
// larger pointer.
test("collapseCached: a body under the floor is never collapsed, and is never recorded as a back-reference", () => {
    const store = memoryStore();
    expect(collapseCached("OK", "verify-install.sh", store, "/logs/x.log").cached).toBe(false);
    expect(collapseCached("OK", "verify-install.sh", store, "/logs/x.log").cached).toBe(false);
    // It also cannot be named as the earlier producer for a different command that happens to print `OK` too.
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

test("collapseCached: the named command is truncated so the marker stays cheap", () => {
    const store = memoryStore();
    const long = `cd /work/intentic && ${"./node_modules/.bin/vitest run src/very/long/path ".repeat(6)}`;
    collapseCached(body("suite"), long, store, "");
    const second = collapseCached(body("suite"), "pnpm test", store, "");
    expect(second.body).toContain("…");
    expect(second.body.length).toBeLessThan(300);
});

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
    // Must stay over CACHE_MIN_BYTES, or the collapse is declined before the never-worse guard runs.
    const raw = `${Array.from({ length: 20 }, (_, i) => `branch-${i} is up to date with origin/main and tracking it cleanly`).join("\n")}\n`;
    expect(filterOutput(raw, "git branch -vv", "0", "0", "", new Set(CLEANERS), store).out).toBe(raw);
    const repeat = filterOutput(raw, "git branch -vv", "0", "0", "/logs/y.log", new Set(CLEANERS), store).out;
    expect(repeat).toContain(CACHE_MARKER);
    // Without a store, the same input passes through unchanged.
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
