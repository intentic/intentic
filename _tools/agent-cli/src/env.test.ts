import { homedir } from "node:os";
import { join } from "node:path";
import { test, expect, afterEach } from "bun:test";
import { toolHome, toolOutDir } from "./env.js";

const CLEARED = ["FILEQ_HOME", "WEBQ_HOME", "XDG_CACHE_HOME"] as const;

afterEach(() => {
    for (const name of CLEARED) {
        delete process.env[name];
    }
});

test("the tool's own variable wins, and it is the name upper-cased", () => {
    process.env["FILEQ_HOME"] = "/tmp/explicit";
    expect(toolHome("fileq")).toBe("/tmp/explicit");
});

test("an empty variable is not a home: it falls through rather than resolving to the filesystem root", () => {
    process.env["WEBQ_HOME"] = "";
    process.env["XDG_CACHE_HOME"] = "/xdg";
    expect(toolHome("webq")).toBe(join("/xdg", "webq"));
});

test("without either variable the home is ~/.cache/<tool>, one directory per tool", () => {
    expect(toolHome("fileq")).toBe(join(homedir(), ".cache", "fileq"));
    expect(toolHome("webq")).toBe(join(homedir(), ".cache", "webq"));
});

test("every tool's output lands under the same leaf name, so one answer locates any of them", () => {
    process.env["XDG_CACHE_HOME"] = "/xdg";
    expect(toolOutDir("webq")).toBe(join("/xdg", "webq", "out"));
    expect(toolOutDir("fileq")).toBe(join("/xdg", "fileq", "out"));
});
