import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { handleMcpMessage } from "./mcp.js";

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({ shell: "on", write: "on", screen: "on", control: "on", ...overrides });

const call = async (name: string, args: Record<string, unknown>, grant: HostScopes): Promise<{ text: string; isError: boolean }> => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, () => grant)) as {
        result: { content: { text?: string }[]; isError: boolean };
    };
    return { text: response.result.content[0]?.text ?? "", isError: response.result.isError };
};

test("initialize advertises tools and identifies the agent", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, scopes)) as {
        result: { capabilities: Record<string, unknown>; serverInfo: { name: string } };
    };
    expect(response.result.capabilities).toHaveProperty("tools");
    expect(response.result.serverInfo.name).toBe("intentic-host");
});

test("tools/list is the machine's whole surface — and there is no delete", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, scopes)) as { result: { tools: { name: string }[] } };
    const names = response.result.tools.map((tool) => tool.name);
    expect(names).toEqual(["describe", "run_command", "read_file", "write_file", "list_dir", "trash_file", "computer", "screenshot"]);
    expect(names).not.toContain("delete_file");
});

// A notification expects no answer; replying to one is a protocol violation the client reports as noise.
test("a notification is handled and answered with nothing", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, scopes)).toBeUndefined();
});

test("an unsupported method is a JSON-RPC error, not a crash", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, scopes)) as { error: { code: number } };
    expect(response.error.code).toBe(-32601);
});

test("a refused scope comes back as a readable tool RESULT, not a transport error", async () => {
    const refused = await call("run_command", { command: "whoami" }, scopes({ shell: "off" }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Run commands.*switched off/);
});

test("writing outside the allowed folders is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const refused = await call("write_file", { path: "/etc/intentic-test", content: "x" }, scopes({ roots: root }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/outside the folders/);
});

test("a write says whether it created or replaced, and a read gets it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "notes", "todo.txt");
    const created = await call("write_file", { path, content: "hello" }, scopes({ roots: root }));
    expect(created.text).toMatch(/^Created /);
    const overwritten = await call("write_file", { path, content: "hello again" }, scopes({ roots: root }));
    expect(overwritten.text).toMatch(/^Overwrote /);
    expect((await call("read_file", { path }, scopes({ roots: root }))).text).toBe("hello again");
});

test("trash moves the file somewhere recoverable instead of deleting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me");
    const trashed = await call("trash_file", { path }, scopes({ roots: root }));
    expect(trashed.isError).toBe(false);
    const moved = /to (.+?)\. It is recoverable/.exec(trashed.text)?.[1];
    expect(moved).toBeDefined();
    expect(await readFile(moved ?? "", "utf8")).toBe("keep me");
});

test("trashing needs the write permission, like any other change to the user's files", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me");
    const refused = await call("trash_file", { path }, scopes({ write: "off", roots: root }));
    expect(refused.isError).toBe(true);
    expect(await readFile(path, "utf8")).toBe("keep me");
});

test("a command that fails is a result with its exit code, not a tool error", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const result = await call("run_command", { command: "exit 3", cwd: root }, scopes({ roots: root }));
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Exit code 3 \(failed\)/);
});

test("a command's output comes back on the stream it was written to", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const result = await call("run_command", { command: "echo out; echo err 1>&2", cwd: root }, scopes({ roots: root }));
    expect(result.text).toContain("--- stdout ---\nout");
    expect(result.text).toContain("--- stderr ---\nerr");
});

test("a command cannot escape the allowed folders by its working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const refused = await call("run_command", { command: "ls", cwd: "/etc" }, scopes({ roots: root }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/outside the folders/);
});

test("a command waiting for input dies on the timeout with an explanation instead of hanging", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const result = await call("run_command", { command: "read -r line", cwd: root, timeoutMs: 1500 }, scopes({ roots: root }));
    // Either the shell reads EOF from the closed stdin (fast, exit code) or the deadline kills it — both are
    // answers the agent can act on, and neither is a hang.
    expect(result.text).toMatch(/Exit code|killed after/);
});

test("describe names the shell, the home and the boundary — what the agent needs before its first command", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const described = await call("describe", {}, scopes({ roots: root }));
    expect(described.text).toContain("Shell for run_command:");
    expect(described.text).toContain(root);
    expect(described.text).toMatch(/Permissions: run commands on/);
});

test("an unknown tool answers plainly rather than throwing", async () => {
    const missing = await call("format_c_drive", {}, scopes());
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/no tool called/);
});
