import { expect, test } from "bun:test";
import { cleanLines, parseCleaners } from "./cleaners.mjs";
import { filterOutput } from "./agent-output-filter.mjs";

const clean = (lines, spec, command = "node worker.js", exitCode = "0") => cleanLines(lines, { command, exitCode, enabled: parseCleaners(spec) });

const csvRecord = (text, start) => {
    let i = start;
    const cells = [];
    let cell = "";
    let quoted = false;
    for (;;) {
        const char = text[i++];
        if (char === undefined) {
            throw new Error("incomplete CSV record");
        }
        if (char === '"') {
            if (quoted && text[i] === '"') {
                cell += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (!quoted && (char === "," || char === "\n")) {
            cells.push(cell);
            cell = "";
            if (char === "\n") {
                return { cells, next: i };
            }
        } else {
            cell += char;
        }
    }
};

// Independent decoder: consume N RFC-4180 records, decode present JSON cells, and replace each table with JSON.
// JSON string scanning prevents a literal '[5]{...}' inside an ordinary string from looking like a table.
const expand = (text) => {
    let output = "";
    for (let i = 0; i < text.length;) {
        if (text[i] === '"') {
            const start = i++;
            while (i < text.length) {
                if (text[i++] === "\\") {
                    i++;
                } else if (text[i - 1] === '"') {
                    break;
                }
            }
            output += text.slice(start, i);
            continue;
        }
        const header = /^\[(\d+)\]\{([A-Za-z_0-9,]+)\}\n/.exec(text.slice(i));
        if (header === null) {
            output += text[i++];
            continue;
        }
        i += header[0].length;
        const keys = header[2].split(",");
        const rows = [];
        for (let row = 0; row < Number(header[1]); row++) {
            const { cells, next } = csvRecord(text, i);
            i = next;
            expect(cells).toHaveLength(keys.length);
            rows.push(Object.fromEntries(cells.flatMap((value, index) => (value === "" ? [] : [[keys[index], JSON.parse(value)]]))));
        }
        output += JSON.stringify(rows);
    }
    return JSON.parse(output);
};

test("templates: four consecutive events fold deterministically with variable ranges", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `2026-10-18T12:00:0${i}Z INFO worker processed job ${i} from 10.0.0.${i} in ${i}ms`);
    const result = clean(lines, "templates");
    expect(result.lines).toEqual([
        lines[0],
        "… 7 more lines like this (varying: 2026-10-18T12:00:00Z..2026-10-18T12:00:07Z, 0..7, 10.0.0.0..10.0.0.7, 0ms..7ms)",
    ]);
    expect(clean(lines, "templates")).toEqual(result);
    expect(result.stages[0].id).toBe("templates");
    expect(result.stages[0].saved).toBeGreaterThan(0);
    expect(clean(lines.slice(0, 3), "templates").lines).toEqual(lines.slice(0, 3));
    expect(clean(lines, "templates", "cat worker.log").lines).toEqual(lines);
});

test("templates: warnings, errors and stack frames break runs and survive repeated verbatim", () => {
    for (const message of ["error", "fatal", "panic", "failed", "exception", "traceback", "warn", "    at method", '    File "worker.py"']) {
        const lines = Array.from({ length: 8 }, (_, i) => `${message} processing request ${i}`);
        expect(clean(lines, "templates,dedup").lines).toEqual(lines);
        expect(
            clean(
                Array.from({ length: 8 }, () => lines[0]),
                "templates,dedup",
            ).lines,
        ).toEqual(Array.from({ length: 8 }, () => lines[0]));
    }
    const lines = ["ordinary text", "another message", "plain text", "done"];
    expect(clean(lines, "templates").lines).toEqual(lines);
});

test("csv-schema: nested document round-trips missing, null, strings, escaped text and nested JSON", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
        identifier: i,
        description: ["null", "", "true", 'a,"b"\r\nc', "[5]{fake}"][i % 5],
        enabled: i % 2 === 0,
        metadata: { values: [1, "two", null] },
        nullable: null,
        ...(i === 2 ? {} : { optional: "present" }),
    }));
    const original = { total: 10, items, other: { literal: "[5]{fake}\ntext" }, second: items };
    const lines = JSON.stringify(original, null, 2).split("\n");
    const result = clean(lines, "csv-schema");
    expect(result.lines.join("\n")).toContain("[10]{identifier,description,enabled,metadata,nullable,optional}");
    expect(expand(result.lines.join("\n"))).toEqual(original);
    expect(clean(lines, "csv-schema")).toEqual(result);
    expect(result.stages[0].saved).toBeGreaterThan(0);
    expect(expand(clean([JSON.stringify(items)], "csv-schema").lines.join("\n"))).toEqual(items);
});

test("csv-schema: nonqualifying and unsafe outputs remain byte-for-byte unchanged", () => {
    for (const value of [
        [],
        [{ a: 1 }],
        [1, 2, 3, 4, 5],
        [{ a: 1 }, {}, {}, {}, {}],
        Array.from({ length: 5 }, () => ({ field: "x".repeat(2001) })),
        Array.from({ length: 5 }, () => ({ "odd,key": 1 })),
    ]) {
        const lines = [JSON.stringify(value)];
        expect(clean(lines, "csv-schema").lines).toEqual(lines);
    }
    for (const text of ["not JSON", '{"a":9007199254740993}', '{"a":-0}', '[{"id":1},2,3,4,5]']) {
        expect(clean([text], "csv-schema").lines).toEqual([text]);
    }
});

const searchRows = () =>
    Array.from({ length: 4 }, (_, file) => Array.from({ length: 70 }, (_unused, row) => `src/file-${file}.ts:${row + 1}:match ${row}`)).flat();

test("search: round-robin allocation names middle files and preserves first hits", () => {
    const lines = searchRows();
    const result = clean(lines, "search,cap", "git grep -n match");
    expect(result.lines).toHaveLength(100);
    for (let file = 0; file < 4; file++) {
        expect(result.lines).toContain(`src/file-${file}.ts: 70 hits, 24 shown`);
        expect(result.lines).toContain(`src/file-${file}.ts:1:match 0`);
    }
    expect(clean(lines, "search,cap", "git grep -n match")).toEqual(result);
    expect(result.stages.map((stage) => stage.id)).toEqual(["search"]);
});

test("search: heading, context, extensionless and Windows paths are accepted", () => {
    const lines = Array.from({ length: 3 }, (_, file) => [
        `src/file-${file}`,
        ...Array.from({ length: 50 }, (_unused, row) => `${row + 1}${row % 2 === 0 ? ":" : "-"}text`),
        "--",
        "",
    ]).flat();
    const out = clean(lines, "search", "rg --heading -n -C1 text").lines;
    expect(out).toContain("src/file-0: 25 hits, 25 shown");
    expect(out).toContain("src/file-1: 25 hits, 25 shown");
    expect(out).toContain("src/file-2: 25 hits, 25 shown");
    const windows = Array.from({ length: 120 }, (_, i) => `C:\\src\\pre-commit.ts${i % 2 === 0 ? ":" : "-"}${i + 1}${i % 2 === 0 ? ":" : "-"}text`);
    expect(clean(windows, "search", "grep -n -C1 text").lines[0]).toBe("C:\\src\\pre-commit.ts: 60 hits, 60 shown");
});

test("search: no shown files have counts; unrecognized and short outputs are untouched", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `file${i}:1:match`);
    const out = clean(lines, "search", "rg -n match").lines;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("file0: 1 hits, 1 shown");
    expect(out.at(-1)).toContain("file59");
    expect(out.at(-1)).toContain("file119");
    expect(out.at(-1)).toStartWith("Files (0 shown): 1 hits each:");
    expect(clean(lines.slice(0, 5), "search", "rg -n match").lines).toEqual(lines.slice(0, 5));
    expect(clean([...lines, "unrecognized diagnostic"], "search", "rg -n match").lines).toEqual([...lines, "unrecognized diagnostic"]);
    expect(clean(lines, "search", "node worker.js").lines).toEqual(lines);
});

test("cap: cut-middle diagnostics and bounded context survive both success and failure caps", () => {
    const lines = Array.from({ length: 900 }, (_, i) => `ordinary line ${i}`);
    const important = [
        "error: broken",
        "FATAL: crash",
        "panic: bad",
        "failed assertion",
        "Exception: bad",
        "Traceback:",
        "warn: caution",
        "    at call (src.ts:1)",
        '    File "src.py", line 1',
        "summary: problems",
    ];
    lines.splice(200, important.length, ...important);
    for (const exitCode of ["0", "1"]) {
        const out = clean(lines, "cap", "node worker.js", exitCode).lines;
        important.forEach((line) => expect(out).toContain(line));
        expect(out.length).toBeLessThanOrEqual(exitCode === "0" ? 100 : 500);
        expect(out).toContain(lines[199]);
        expect(out).toContain(lines[210]);
    }
});

test("search: error hits survive sampling and output remains bounded", () => {
    const lines = searchRows();
    lines[130] = "src/file-1.ts:61:error: broken";
    const out = clean(lines, "search,cap", "rg -n match").lines;
    expect(out).toContain(lines[130]);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.join("\n").length).toBeLessThanOrEqual(16000);
});

test("retrieval: template folds and search sampling retain the complete original", () => {
    for (const [lines, command, spec] of [
        [
            Array.from({ length: 30 }, (_, i) => `INFO worker completed a long processing job with request identifier ${i}`),
            "node worker.js",
            "templates",
        ],
        [searchRows(), "rg -n match", "search"],
    ]) {
        let retained;
        const result = filterOutput(`${lines.join("\n")}\n`, {
            command,
            enabled: parseCleaners(spec),
            retain: (text) => {
                retained = text;
                return "/raw/test.log";
            },
        });
        expect(retained).toBe(lines.join("\n"));
        expect(result.out).toContain("retrieve-output /raw/test.log");
        expect(result.stages.reduce((sum, stage) => sum + stage.saved, 0)).toBe(`${lines.join("\n")}\n`.length - result.out.length);
    }
});

test("csv-schema: repeated rows round-trip through the complete pipeline", () => {
    const original = Array.from({ length: 8 }, () => ({ identifier: 1, description: "identical value", enabled: true }));
    const result = filterOutput(JSON.stringify(original), { command: "gh api" });
    expect(expand(result.out)).toEqual(original);
    expect(result.stages.some((stage) => stage.id === "dedup")).toBe(false);
});

test("csv-schema: named credentials keep their original shape for the final redactor", () => {
    const secret = "abcdefghijklmnopqrstuvwxyz0123456789";
    const raw = JSON.stringify(Array.from({ length: 8 }, () => ({ API_TOKEN: secret, identifier: 1 })));
    const result = filterOutput(raw, { command: "gh api" });
    expect(result.out.includes(secret)).toBe(false);
    expect(result.stages.find((stage) => stage.id === "csv-schema").saved).toBe(0);
});

test("csv-schema: a later cap on a one-line JSON input still gets a raw retrieval pointer", () => {
    const original = Array.from({ length: 300 }, (_, identifier) => ({ identifier, description: `item ${identifier}`, enabled: true }));
    const raw = JSON.stringify(original);
    let retained;
    const result = filterOutput(raw, {
        command: "gh api",
        retain: (text) => {
            retained = text;
            return "/raw/json.log";
        },
    });
    expect(retained).toBe(raw);
    expect(result.out).toContain("output truncated");
    expect(result.out).toContain("retrieve-output /raw/json.log");
});

test("csv-schema: mixed column types are left unchanged", () => {
    const raw = JSON.stringify(
        Array.from({ length: 8 }, (_, index) => ({ identifier: index % 2 === 0 ? index : String(index), description: "text" })),
    );
    expect(clean([raw], "csv-schema").lines).toEqual([raw]);
});

test("templates: listings and test-runner file names are not log templates", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `644 agent-module-${index}.ts 3.7K`);
    expect(clean(lines, "templates", "ls -l").lines).toEqual(lines);
    const tests = Array.from({ length: 20 }, (_, index) => `✓ src/mod-${index}.test.ts (1) ${index}ms`);
    expect(clean(tests, "templates", "vitest").lines).toEqual(tests);
});

test("cap: diagnostics and their neighbours respect line and byte budgets under saturation", () => {
    const lines = Array.from({ length: 300 }, (_, index) => `warn: diagnostic ${index} ${"detail ".repeat(40)}`);
    const out = clean(lines, "cap").lines;
    expect(out[0]).toBe(lines[0]);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.join("\n").length).toBeLessThanOrEqual(16000);
    expect(out.at(-1)).toContain("lines elided");
    const ordinary = Array.from({ length: 300 }, (_, index) => `message ${index} ${"detail ".repeat(40)}`);
    expect(clean(ordinary, "cap").lines.join("\n").length).toBeLessThanOrEqual(16000);
});

test("templates: a summary cannot detach credentials from the names that trigger redaction", () => {
    const secrets = Array.from({ length: 8 }, (_, index) => `credential${index}abcdefghijk0123456789`);
    const raw = secrets.map((secret) => `INFO worker loaded API_TOKEN='${secret}'`).join("\n");
    const result = filterOutput(raw, { command: "node worker.js" });
    secrets.forEach((secret) => expect(result.out.includes(secret)).toBe(false));
    expect(result.stages.find((stage) => stage.id === "templates").saved).toBe(0);
});

test("csv-schema: leading blank lines do not stop whole-JSON recognition", () => {
    const original = Array.from({ length: 8 }, (_, identifier) => ({ identifier, description: "text" }));
    const result = clean(["", "  ", JSON.stringify(original)], "csv-schema");
    expect(expand(result.lines.join("\n"))).toEqual(original);
    expect(result.stages[0].saved).toBeGreaterThan(0);
});

test("retrieval: lossy summaries are skipped when no handle survives", () => {
    const lines = Array.from({ length: 8 }, (_, index) => `INFO worker processed request ${index}`);
    const raw = `${lines.join("\n")}\n`;
    for (const retain of [undefined, () => undefined, () => "x".repeat(500)]) {
        const result = filterOutput(raw, { command: "node worker.js", enabled: parseCleaners("templates"), retain });
        expect(result.out).toBe(raw);
    }
    const short =
        "INFO worker processed request 1\nINFO worker processed request 2\nINFO worker processed request 3\nINFO worker processed request 4\n";
    expect(filterOutput(short, { command: "node worker.js", enabled: parseCleaners("templates"), retain: () => "/raw/file" }).out).toBe(short);
});

test("templates: quoted values, hex, UUIDs and trailing path ids share a template", () => {
    const lines = Array.from(
        { length: 8 },
        (_, index) =>
            `INFO worker processed /api/jobs/${index} hex 0xabc${index} uuid 12345678-1234-1234-1234-12345678900${index} label "item ${index}"`,
    );
    const out = clean(lines, "templates").lines;
    expect(out).toEqual([
        lines[0],
        '… 7 more lines like this (varying: 0..7, 0xabc0..0xabc7, 12345678-1234-1234-1234-123456789000..12345678-1234-1234-1234-123456789007, "item 0".."item 7")',
    ]);
});
