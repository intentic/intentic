import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModels, monorepoRoot } from "./repos.js";

let root: string;
let previousModelDir: string | undefined;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iq-bench-models-"));
    previousModelDir = process.env["IQ_MODEL_DIR"];
    // Any regression to a shell must fail without running the real model downloader.
    jest.spyOn(childProcess, "execSync").mockImplementation(() => {
        throw new Error("model paths must not be interpreted by a shell");
    });
});

afterEach(() => {
    jest.restoreAllMocks();
    if (previousModelDir === undefined) {
        delete process.env["IQ_MODEL_DIR"];
    } else {
        process.env["IQ_MODEL_DIR"] = previousModelDir;
    }
    rmSync(root, { recursive: true, force: true });
});

test.each(["models with spaces", "models; echo injected", "models$(echo injected)"])("model directory %j is passed as one literal argument", (name) => {
    const dir = join(root, name);
    process.env["IQ_MODEL_DIR"] = dir;
    const run = jest.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));

    expect(ensureModels()).toBe(dir);
    expect(run.mock.calls).toEqual([[process.execPath, [join(monorepoRoot, "_search/iq-engine/scripts/fetch-model.mjs"), dir], { stdio: "inherit" }]]);
    expect(childProcess.execSync).not.toHaveBeenCalled();
});

test("cached models do not launch a downloader", () => {
    process.env["IQ_MODEL_DIR"] = root;
    const run = jest.spyOn(childProcess, "execFileSync").mockReturnValue(Buffer.alloc(0));
    expect(ensureModels()).toBe(root);
    expect(run).not.toHaveBeenCalled();
});

test("a failed downloader leaves semantic configurations skipped", () => {
    process.env["IQ_MODEL_DIR"] = join(root, "missing");
    jest.spyOn(childProcess, "execFileSync").mockImplementation(() => {
        throw new Error("download unavailable");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(ensureModels()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("iq-bench: model fetch failed, semantic/rerank configs will be skipped");
});
