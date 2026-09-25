import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentHome } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { handleMcpMessage } from "./mcp.js";

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => ({
    shell: "on",
    write: "on",
    screen: "on",
    control: "on",
    sandboxes: "on",
    destructive: "on",
    ...overrides,
});

// `text` is the first block, the one a program reading a tool's answer takes; `texts` is every block, in order.
const call = async (name: string, args: Record<string, unknown>, grant: DeviceScopes): Promise<{ text: string; texts: string[]; isError: boolean }> => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, grant)) as {
        result: { content: { text?: string }[]; isError: boolean };
    };
    const texts = response.result.content.map((block) => block.text ?? "");
    return { text: texts[0] ?? "", texts, isError: response.result.isError };
};

test("initialize advertises tools and identifies the agent", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, scopes())) as {
        result: { capabilities: Record<string, unknown>; serverInfo: { name: string } };
    };
    expect(response.result.capabilities).toHaveProperty("tools");
    expect(response.result.serverInfo.name).toBe("intentic-machine");
});

test("tools/list is the machine's whole surface, and there is no delete", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, scopes())) as { result: { tools: { name: string }[] } };
    const names = response.result.tools.map((tool) => tool.name);
    expect(names).toEqual([
        "describe",
        "run_command",
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "trash_file",
        "list_windows",
        "focus_window",
        "open",
        "clipboard",
        "browser_open",
        "browser_snapshot",
        "browser_read",
        "browser_click",
        "browser_fill",
        "browser_key",
        "browser_tabs",
        "device",
        "screenshot",
        "list_sandboxes",
        "manage_sandbox",
        "swap_sandbox",
        "reshape_sandbox",
        "remove_sandbox",
        "sandbox_logs",
    ]);
    expect(names).not.toContain("delete_file");
    // remove_sandbox is the one exception to "there is no delete", and is not a file tool: it deletes a sandbox
    // behind its own switch, a different grant from anything under the roots.
    expect(names).not.toContain("remove_file");
});

// `items: false` at any depth: zod's closed-tuple form, the one schema llama.cpp's grammar converter refuses.
const closedTuple = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(([key, child]) => (key === "items" && child === false) || closedTuple(child));

// Every tool publishes the schema its arguments are checked against. Asserted structurally so a tool added
// without a schema fails here instead of being advertised as taking anything.
test("tools/list publishes each tool's argument schema, which is the one an arriving call is held to", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, scopes())) as {
        result: { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
    };
    for (const entry of response.result.tools) {
        expect(entry.description.length, entry.name).toBeGreaterThan(0);
        expect(entry.inputSchema["type"], entry.name).toBe("object");
        expect(entry.inputSchema, entry.name).toHaveProperty("properties");
        // One schema llama.cpp cannot convert fails the WHOLE tool set, so a tuple published this way kills every
        // tool-carrying turn on a local model before its first token.
        expect(closedTuple(entry.inputSchema), entry.name).toBe(false);
    }
    const logs = response.result.tools.find((entry) => entry.name === "sandbox_logs");
    const lines = (logs?.inputSchema["properties"] as { lines: { maximum: number; description: string } } | undefined)?.lines;
    // The ceiling the model is told is the ceiling it is held to, below: one number, not two.
    expect(lines?.maximum).toBe(2000);
    expect(lines?.description).toContain("maximum 2000");
});

test("an argument the schema does not accept is a readable result, and nothing is looked at", async () => {
    const badOp = await call("manage_sandbox", { op: "kill", slug: "work" }, scopes());
    expect(badOp.isError).toBe(true);
    expect(badOp.text).toMatch(/op/);
    const badSwap = await call("swap_sandbox", { op: "remove", slug: "work" }, scopes());
    expect(badSwap.isError).toBe(true);
    // Past the published ceiling, refused rather than quietly trimmed.
    const tooMany = await call("sandbox_logs", { slug: "work", lines: 9000 }, scopes());
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toMatch(/lines/);
    const noPath = await call("read_file", { path: "" }, scopes());
    expect(noPath.isError).toBe(true);
});

// A notification expects no answer; replying to one is a protocol violation the client reports as noise.
test("a notification is handled and answered with nothing", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, scopes())).toBeUndefined();
});

test("an unsupported method is a JSON-RPC error, not a crash", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, scopes())) as { error: { code: number } };
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

test("a write says whether it created or replaced, and replacing takes the revision a read answered with", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "notes", "todo.txt");
    const created = await call("write_file", { path, content: "hello" }, scopes({ roots: root }));
    expect(created.text).toMatch(/^Created /);
    const blind = await call("write_file", { path, content: "hello again" }, scopes({ roots: root }));
    expect(blind.isError).toBe(true);
    expect(blind.text).toMatch(/already exists\. Read it first/);
    const revision = /Revision ([0-9a-f]{16})/.exec((await call("read_file", { path }, scopes({ roots: root }))).texts[1] ?? "")?.[1];
    const overwritten = await call("write_file", { path, content: "hello again", revision }, scopes({ roots: root }));
    expect(overwritten.text).toMatch(/^Overwrote /);
    expect((await call("read_file", { path }, scopes({ roots: root }))).text).toBe("hello again");
});

// The setup import reads files through this tool from the sandbox (migrations/host-scan.ts) and takes the first text
// block as the file: the note has to ride in a block of its own.
test("read_file answers with the file's text alone in its first block, and the note after it", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "config.yaml");
    await writeFile(path, "model: big\n");
    const read = await call("read_file", { path }, scopes({ roots: root }));
    expect(read.isError).toBe(false);
    expect(read.texts).toEqual(["model: big\n", expect.stringMatching(/^All 1 line\. Revision [0-9a-f]{16}: /)]);
});

test("edit_file changes one exact piece of a file, on the revision it was read at", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-fs-"));
    const path = join(root, "app.ts");
    await writeFile(path, "const port = 3000;\n");
    const revision = /Revision ([0-9a-f]{16})/.exec((await call("read_file", { path }, scopes({ roots: root }))).texts[1] ?? "")?.[1];
    const edited = await call("edit_file", { path, old_string: "3000", new_string: "4000", revision }, scopes({ roots: root }));
    expect(edited.text).toMatch(/^Edited /);
    expect(await readFile(path, "utf8")).toBe("const port = 4000;\n");
    const refused = await call("edit_file", { path, old_string: "4000", new_string: "5000", revision }, scopes({ write: "off", roots: root }));
    expect(refused.text).toMatch(/Create and change files/);
});

// What a runtime may run side by side (read-only) and what it must treat as able to lose something. Every other tool
// is a `write`: it changes something that can be put back.
test("every tool says what a call can do to the device", async () => {
    const response = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, scopes())) as {
        result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] };
    };
    const tools = response.result.tools;
    expect(tools.filter((entry) => entry.annotations.readOnlyHint).map((entry) => entry.name)).toEqual([
        "describe",
        "read_file",
        "list_dir",
        "list_windows",
        "browser_snapshot",
        "browser_read",
        "screenshot",
        "list_sandboxes",
        "sandbox_logs",
    ]);
    expect(tools.filter((entry) => entry.annotations.destructiveHint).map((entry) => entry.name)).toEqual([
        "run_command",
        "write_file",
        "open",
        "clipboard",
        "browser_click",
        "browser_fill",
        "browser_key",
        "device",
        "remove_sandbox",
    ]);
});

test("trash moves the file somewhere recoverable instead of deleting it", async () => {
    // The file must share a filesystem with the real trash for files.ts's rename to work: Bun's homedir() ignores a
    // stubbed $HOME, and a container job's $HOME (bind mount) and tmpdir() (image layer) are two devices.
    const home = agentHome("machine").dir;
    mkdirSync(home, { recursive: true });
    const root = mkdtempSync(join(home, "test-trash-"));
    const path = join(root, "doomed.txt");
    await writeFile(path, "keep me");
    const trashed = await call("trash_file", { path }, scopes({ roots: root }));
    const moved = /to (.+?)\. It is recoverable/.exec(trashed.text)?.[1];
    try {
        expect(trashed.isError, trashed.text).toBe(false);
        // An absolute path, which is the claim the message makes ("to <path>. It is recoverable") and the part a
        // reader would act on.
        expect(moved).toMatch(/^\//);
        expect(await readFile(moved ?? "", "utf8")).toBe("keep me");
    } finally {
        await rm(root, { recursive: true, force: true });
        if (moved !== undefined) {
            await rm(dirname(moved), { recursive: true, force: true });
        }
    }
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
    // Either the shell reads EOF from the closed stdin (fast, exit code) or the deadline kills it: both are
    // answers the agent can act on, neither is a hang.
    expect(result.text).toMatch(/Exit code|killed after/);
});

test("describe names the shell, the home and the boundary: what the agent needs before its first command", async () => {
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

// A reshape with nothing to change is refused as a readable RESULT, the same shape a wrong op or a
// switched-off scope comes back in.
test("reshape_sandbox refuses an empty ask as a readable result, not a transport fault", async () => {
    // A call with nothing in it once meant "apply what is saved now", a restart nobody asked for by name. It changes
    // nothing now, and says what to send instead.
    const empty = await call("reshape_sandbox", { slug: "work" }, scopes());
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/Nothing was changed: give at least one field/);
    // A field without `when` (an older model's `later`, which the schema no longer carries) is refused the same way,
    // rather than read as "now".
    const untimed = await call("reshape_sandbox", { slug: "work", memoryGib: 12, later: true }, scopes());
    expect(untimed.isError).toBe(true);
    expect(untimed.text).toMatch(/Nothing was changed/);
    const tangled = await call("reshape_sandbox", { slug: "work", memoryGib: 12, forget: true }, scopes());
    expect(tangled.isError).toBe(true);
    expect(tangled.text).toMatch(/`forget` drops what is saved and takes nothing else/);
    // A malformed cap is caught by the schema before the machine is touched: whole GiB, whole cores.
    const fractional = await call("reshape_sandbox", { slug: "work", cpus: 1.5 }, scopes());
    expect(fractional.isError).toBe(true);
    expect(fractional.text).toMatch(/cpus/i);
    // Scope refusal names the switch, like every other sandbox tool.
    const refused = await call("reshape_sandbox", { slug: "work", memoryGib: 12, when: "nextRestart" }, scopes({ sandboxes: "off" }));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Manage sandboxes on this device/);
});
