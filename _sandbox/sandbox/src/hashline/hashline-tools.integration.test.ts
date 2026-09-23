import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { afterEach, expect, test } from "bun:test";
import { fileAnchor } from "./hashline.js";
import { createHashlineServer } from "./hashline-tools.js";

// The tools as the model meets them: called through the SDK server's own registry against a real temp workspace.
// `_registeredTools` is private to McpServer, hence the cast.

interface Registered {
    readonly annotations: unknown;
    readonly handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

const workspace = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), "hashline-tools-"));
    roots.push(root);
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(root, name), content);
    }
    const registry = createHashlineServer(root).instance as unknown as { _registeredTools: Record<string, Registered> };
    const tools = registry["_registeredTools"];
    const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
        const result = await tools[name]?.handler(args, {});
        return { text: result?.content.map((part) => part.text).join("\n") ?? "", isError: result?.isError === true };
    };
    return { root, tools, call };
};

// The anchor and each `<tag> <n>│` row's tag by line number, from a read or an edit's answer.
const parse = (text: string): { anchor: string; tagOf: (line: number) => string; lines: number[] } => {
    const rows = text.split("\n").flatMap((row) => {
        const match = /^(\w{4}) (\d+)│/.exec(row);
        return match === null ? [] : [{ tag: match[1] ?? "", line: Number(match[2]) }];
    });
    return {
        anchor: /^anchor (\w+)/.exec(text)?.[1] ?? "",
        tagOf: (line) => rows.find((row) => row.line === line)?.tag ?? "",
        lines: rows.map((row) => row.line),
    };
};

test("read is marked read-only; edit and write change files but destroy nothing", async () => {
    const { tools } = await workspace({});
    expect(tools["read"]?.annotations).toEqual(toolAnnotations("read"));
    expect(tools["edit"]?.annotations).toEqual(toolAnnotations("write"));
    expect(tools["write"]?.annotations).toEqual(toolAnnotations("write"));
});

test("read takes a line range and says which lines it shows", async () => {
    const file = "1\n2\n3\n4\n5\n";
    const { call } = await workspace({ "five.txt": file });
    const { text } = await call("read", { path: "five.txt", offset: 2, limit: 2 });
    const [header, ...rows] = text.split("\n");
    expect(header).toBe(`anchor ${fileAnchor(file)} · lines 2-3 of 5: pass this anchor and the line tags to hashline_edit; the rest: hashline_read with offset 4`);
    expect(rows.map((row) => row.slice(5))).toEqual(["2│2", "3│3"]);
});

test("an edit of a CRLF file writes CRLF lines and leaves every other byte alone", async () => {
    const { root, call } = await workspace({ "win.txt": "alpha\r\nbeta\r\ngamma\r\n" });
    const read = parse((await call("read", { path: "win.txt" })).text);
    const edit = await call("edit", { path: "win.txt", anchor: read.anchor, ops: [{ op: "replace", from: read.tagOf(2), lines: ["BETA", "delta"] }] });
    expect(edit.isError).toBe(false);
    expect(await readFile(join(root, "win.txt"), "utf8")).toBe("alpha\r\nBETA\r\ndelta\r\ngamma\r\n");
});

test("edits chain on each answer, which carries only the lines around the change", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const { root, call } = await workspace({ "long.txt": `${lines.join("\n")}\n` });
    const read = parse((await call("read", { path: "long.txt" })).text);
    const first = parse((await call("edit", { path: "long.txt", anchor: read.anchor, ops: [{ op: "replace", from: read.tagOf(20), lines: ["twenty"] }] })).text);
    expect(first.lines).toEqual([18, 19, 20, 21, 22]);
    const second = await call("edit", {
        path: "long.txt",
        anchor: first.anchor,
        ops: [
            { op: "insert", after: first.tagOf(21), lines: ["after twenty-one"] },
            { op: "delete", from: read.tagOf(35) },
        ],
    });
    expect(second.isError).toBe(false);
    const expected = [...lines.slice(0, 19), "twenty", "line 21", "after twenty-one", ...lines.slice(21, 34), ...lines.slice(35)];
    expect(await readFile(join(root, "long.txt"), "utf8")).toBe(`${expected.join("\n")}\n`);
});

test("of two edits built on one anchor, one lands and the other is refused as stale", async () => {
    const { root, call } = await workspace({ "a.txt": "one\ntwo\nthree\n" });
    const read = parse((await call("read", { path: "a.txt" })).text);
    const results = await Promise.all([
        call("edit", { path: "a.txt", anchor: read.anchor, ops: [{ op: "replace", from: read.tagOf(1), lines: ["ONE"] }] }),
        call("edit", { path: "a.txt", anchor: read.anchor, ops: [{ op: "replace", from: read.tagOf(3), lines: ["THREE"] }] }),
    ]);
    expect(results.map((result) => result.isError).toSorted()).toEqual([false, true]);
    expect(results.find((result) => result.isError)?.text).toStartWith("stale edit:");
    expect(["ONE\ntwo\nthree\n", "one\ntwo\nTHREE\n"]).toContain(await readFile(join(root, "a.txt"), "utf8"));
});

test("an edit through a symlink replaces the target atomically, keeping the link and the mode", async () => {
    const { root, call } = await workspace({ "real.sh": "echo one\necho two\n" });
    // Group and other write: bits the umask strips from a freshly created file.
    await chmod(join(root, "real.sh"), 0o666);
    await symlink("real.sh", join(root, "link.sh"));
    const read = parse((await call("read", { path: "link.sh" })).text);
    await call("edit", { path: "link.sh", anchor: read.anchor, ops: [{ op: "replace", from: read.tagOf(2), lines: ["echo TWO"] }] });
    expect(await readFile(join(root, "real.sh"), "utf8")).toBe("echo one\necho TWO\n");
    expect((await lstat(join(root, "link.sh"))).isSymbolicLink()).toBe(true);
    expect((await stat(join(root, "real.sh"))).mode & 0o7777).toBe(0o666);
    expect((await readdir(root)).toSorted()).toEqual(["link.sh", "real.sh"]);
});

test("write creates a file and its folders, and an overwrite keeps the file's mode", async () => {
    const { root, call } = await workspace({ "run.sh": "old\n" });
    await chmod(join(root, "run.sh"), 0o775);
    expect(await call("write", { path: "run.sh", content: "new\n" })).toEqual({ text: "wrote run.sh (4 bytes)", isError: false });
    expect(await readFile(join(root, "run.sh"), "utf8")).toBe("new\n");
    expect((await stat(join(root, "run.sh"))).mode & 0o7777).toBe(0o775);
    await call("write", { path: "sub/dir/fresh.txt", content: "hi" });
    expect(await readFile(join(root, "sub/dir/fresh.txt"), "utf8")).toBe("hi");
    expect((await readdir(root)).toSorted()).toEqual(["run.sh", "sub"]);
});
