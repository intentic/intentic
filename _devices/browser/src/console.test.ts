import { CONSOLE_CAP, ConsoleLog, consoleEntryOf, formatArgs } from "./console.js";

/* The page's console as CDP events arrive: what the page logged itself, what it threw, and what the browser logged about
   it (a failed request, a WebGPU or WebGL warning). Each event becomes one entry; the rest of the protocol is ignored. */

const NOW = 1_700_000_000_000;

test("a console call becomes its text, its level and where it was made, lines counted from one", () => {
    const entry = consoleEntryOf(
        "Runtime.consoleAPICalled",
        {
            type: "warning",
            timestamp: NOW + 5,
            args: [
                { type: "string", value: "device lost:" },
                { type: "number", value: 3 },
            ],
            stackTrace: { callFrames: [{ url: "http://localhost:8080/game.js", lineNumber: 41 }] },
        },
        NOW,
    );
    expect(entry).toEqual({ at: NOW + 5, level: "warning", source: "console", text: "device lost: 3", where: "http://localhost:8080/game.js:42" });
});

test("console.error and console.assert read as errors, everything unnamed as a log", () => {
    expect(consoleEntryOf("Runtime.consoleAPICalled", { type: "error", args: [] }, NOW)?.level).toBe("error");
    expect(consoleEntryOf("Runtime.consoleAPICalled", { type: "assert", args: [] }, NOW)?.level).toBe("error");
    expect(consoleEntryOf("Runtime.consoleAPICalled", { type: "table", args: [] }, NOW)?.level).toBe("log");
    expect(consoleEntryOf("Runtime.consoleAPICalled", { type: "debug", args: [] }, NOW)?.level).toBe("debug");
});

test("format directives take the next argument, and %c's CSS shows nothing", () => {
    expect(
        formatArgs([
            { type: "string", value: "%cframe %d took %sms %%" },
            { type: "string", value: "color: red" },
            { type: "number", value: 7 },
            { type: "string", value: "33" },
            { type: "boolean", value: true },
        ]),
    ).toBe("frame 7 took 33ms % true");
});

test("objects read by their preview, errors by their stack, the odd values as the console writes them", () => {
    expect(
        formatArgs([
            { type: "string", value: "state" },
            { type: "object", description: "Object", preview: { properties: [{ name: "fps", type: "number", value: "60" }, { name: "scene", type: "string", value: "arena" }] } },
        ]),
    ).toBe('state {fps: 60, scene: "arena"}');
    expect(formatArgs([{ type: "object", subtype: "array", description: "Array(3)", preview: { properties: [{ name: "0", value: "1" }], overflow: true } }])).toBe("[1, …]");
    expect(formatArgs([{ type: "object", subtype: "error", description: "TypeError: x is null\n    at draw (game.js:3)" }])).toBe("TypeError: x is null\n    at draw (game.js:3)");
    expect(formatArgs([{ type: "undefined" }, { type: "object", subtype: "null", value: null }, { type: "number", unserializableValue: "NaN" }])).toBe("undefined null NaN");
});

test("an uncaught error carries the browser's prefix, the stack and the place it was thrown", () => {
    const entry = consoleEntryOf(
        "Runtime.exceptionThrown",
        {
            timestamp: NOW,
            exceptionDetails: {
                text: "Uncaught",
                url: "http://localhost:8080/pkg/game.js",
                lineNumber: 0,
                exception: { type: "object", subtype: "error", description: "RuntimeError: unreachable\n    at wasm-function[812]" },
            },
        },
        NOW,
    );
    expect(entry).toEqual({
        at: NOW,
        level: "error",
        source: "exception",
        text: "Uncaught RuntimeError: unreachable\n    at wasm-function[812]",
        where: "http://localhost:8080/pkg/game.js:1",
    });
});

test("what the browser logs about the page keeps the browser's own source", () => {
    const entry = consoleEntryOf(
        "Log.entryAdded",
        { entry: { source: "network", level: "error", text: "Failed to load resource: 404", url: "http://localhost:8080/atlas.png", timestamp: NOW } },
        NOW,
    );
    expect(entry).toEqual({ at: NOW, level: "error", source: "network", text: "Failed to load resource: 404", where: "http://localhost:8080/atlas.png" });
    expect(consoleEntryOf("Log.entryAdded", { entry: { source: "rendering", level: "verbose", text: "x" } }, NOW)?.level).toBe("debug");
});

test("a navigation is marked, and every other event is not an entry", () => {
    expect(consoleEntryOf("Runtime.executionContextsCleared", {}, NOW)).toMatchObject({ source: "page", level: "info" });
    expect(consoleEntryOf("Runtime.executionContextCreated", { context: {} }, NOW)).toBeUndefined();
    expect(consoleEntryOf("Log.entryAdded", {}, NOW)).toBeUndefined();
});

test("a long message is cut and says how much it left out", () => {
    const text = consoleEntryOf("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "x".repeat(2500) }] }, NOW)?.text ?? "";
    expect(text).toBe(`${"x".repeat(2000)}… (500 more characters)`);
});

test("the log keeps the newest entries and counts the ones it let go", () => {
    const log = new ConsoleLog();
    for (let index = 0; index < CONSOLE_CAP + 3; index += 1) {
        log.take("Runtime.consoleAPICalled", { type: "log", timestamp: index, args: [{ type: "number", value: index }] });
    }
    log.take("Runtime.executionContextCreated", {});
    const { entries, dropped } = log.read();
    expect(dropped).toBe(3);
    expect(entries).toHaveLength(CONSOLE_CAP);
    expect(entries[0]?.text).toBe("3");
    expect(entries.at(-1)?.text).toBe(String(CONSOLE_CAP + 2));
});
