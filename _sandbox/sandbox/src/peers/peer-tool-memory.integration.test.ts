import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { filePeerTools, peerToolsFile } from "./peer-tool-memory.js";

// The half a daemon restart used to lose: what a peer publishes has to outlive the process, or a browser whose laptop
// is shut comes back with no tools and the turn reading its skill finds nothing to call.

const roots: string[] = [];
const silent = { warn: () => {} };

const root = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "peer-tools-"));
    roots.push(dir);
    return dir;
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

test("what a peer published is there for the next boot, keyed by its door", async () => {
    const historyRoot = await root();
    const tools = { tools: [{ name: "snapshot" }] };
    filePeerTools(historyRoot, silent).set("webext:chrome", tools);
    await waitFor(async () => expect(JSON.parse(await readFile(peerToolsFile(historyRoot), "utf8"))).toEqual({ peers: { "webext:chrome": tools } }));

    const afterRestart = filePeerTools(historyRoot, silent);
    await waitFor(() => expect(afterRestart.get("webext:chrome")).toEqual(tools));
    expect(afterRestart.get("webext:firefox")).toBeUndefined();
});

// The read is synchronous because an MCP client is waiting on it, so hydration races the first call; what this boot was
// told must win, or a peer that just relisted would answer with the last boot's table.
test("a peer that has already answered this boot beats what the file remembers", async () => {
    const historyRoot = await root();
    filePeerTools(historyRoot, silent).set("hosts:laptop", { tools: [{ name: "run_command" }] });
    await waitFor(async () => expect(await readFile(peerToolsFile(historyRoot), "utf8")).toContain("run_command"));

    const afterRestart = filePeerTools(historyRoot, silent);
    afterRestart.set("hosts:laptop", { tools: [{ name: "run_command" }, { name: "screenshot" }] });
    await waitFor(async () => expect(await readFile(peerToolsFile(historyRoot), "utf8")).toContain("screenshot"));
    expect(afterRestart.get("hosts:laptop")).toEqual({ tools: [{ name: "run_command" }, { name: "screenshot" }] });
});

test("nothing remembered is the answer before anything is written, not a failure", async () => {
    expect(filePeerTools(await root(), silent).get("webext:chrome")).toBeUndefined();
});

// A rekeyed peer moves its table (PeerHub.rekey): the old key is forgotten in the file too, or the next boot would list
// the renamed machine's tools under its old name as well.
test("a forgotten key is gone from the file, and from the next boot", async () => {
    const historyRoot = await root();
    const memory = filePeerTools(historyRoot, silent);
    memory.set("hosts:rog", { tools: [{ name: "run_command" }] });
    memory.set("hosts:desk", { tools: [{ name: "run_command" }] });
    memory.delete("hosts:rog");
    expect(memory.get("hosts:rog")).toBeUndefined();
    await waitFor(async () => expect(Object.keys(JSON.parse(await readFile(peerToolsFile(historyRoot), "utf8")).peers)).toEqual(["hosts:desk"]));

    const afterRestart = filePeerTools(historyRoot, silent);
    await waitFor(() => expect(afterRestart.get("hosts:desk")).toEqual({ tools: [{ name: "run_command" }] }));
    expect(afterRestart.get("hosts:rog")).toBeUndefined();
});
