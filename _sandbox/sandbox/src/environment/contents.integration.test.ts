import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/workspace-files.js";
import { readEnvironmentContents } from "./contents.js";
import { customPath, proposalPath } from "./environment.js";
import { clearVersionCache } from "./version-probe.js";

/* The contents view end to end: real files on disk, real capability fragments, real probes.
 *
 * The probes are the reason this is an integration test rather than a unit one, and the reason it asserts on
 * `node`: this suite runs ON node, so `node --version` is the one command every machine that can run these
 * tests is guaranteed to have. Everything else is asserted on its NAME and its grouping, never on a version
 * number, because a version is by definition whatever the machine happens to have. */

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const stubServices = (capabilities: Capability[] = [], environmentHash = ""): Services =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", {
            sandbox: {
                profile: "container",
                port: 8787,
                host: "0.0.0.0",
                publicUrl: "",
                allowUnauthenticated: false,
                environmentHash,
                name: "intentic-sandbox-demo",
                image: "",
                baseImage: "",
                channel: "",
                previousImage: "",
            },
            extensionsDir: EXTENSIONS_DIR,
            openaiApiKey: "",
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: mkdtempSync(join(tmpdir(), "contents-")) }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile, write: writeWorkspaceFile, remove: removeWorkspacePath }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        authRoot: mkdtempSync(join(tmpdir(), "contents-auth-")),
        openCode: unstubbed<Services["openCode"]>("openCode", { connected: async () => false }),
    });

// A block whose command is guaranteed present (this suite runs on node) and one whose command cannot be.
const CUSTOM = `# ---- node-tools ----
# Reads the workspace's package manifests. Needed because the release script parses them before it tags.
RUN echo pretend-install && node --version

# ---- absent-tool ----
# A tool nothing has installed yet.
RUN apt-get install -y definitely-not-a-real-command-9z
`;

test("groups what the owner approved, names it, and reads its version off the tool itself", async () => {
    clearVersionCache();
    const services = stubServices();
    await writeWorkspaceFile(customPath(services), CUSTOM);

    const { items } = await readEnvironmentContents(services);
    const custom = items.filter((item) => item.origin === "custom");
    expect(custom.map((item) => item.name)).toEqual(["Node tools", "Absent tool"]);

    // Present: the probe found it, so the row is active and carries the version node itself reports.
    const present = custom[0];
    expect(present?.state).toBe("active");
    expect(present?.tools.map((tool) => tool.name)).toContain("node");
    expect(present?.tools.find((tool) => tool.name === "node")?.version).toBe(process.version.slice(1));
    expect(present?.purpose).toBe("Reads the workspace's package manifests.");
    // The disclosure carries the comment whole rather than the comment minus the row's line: the view shows one
    // of the two, so a remainder is what made every long entry open on its own opening sentence twice.
    expect(present?.detail).toBe("Reads the workspace's package manifests. Needed because the release script parses them before it tags.");
    expect(present?.commands).toBe("RUN echo pretend-install && node --version");

    /* Absent: the recipe has it and the container does not, which is exactly "arrives with the next rebuild".
     * Derived from the PROBE, not from comparing hashes, which is what makes it per-item rather than per-card. */
    expect(custom[1]?.state).toBe("after-rebuild");
    expect(custom[1]?.tools).toEqual([]);
});

test("a proposal's new blocks are marked as the decision the owner has not made yet", async () => {
    clearVersionCache();
    const services = stubServices();
    await writeWorkspaceFile(customPath(services), CUSTOM);
    // A proposal carries the approved section forward and appends what the agent is asking for.
    await writeWorkspaceFile(proposalPath(services), `${CUSTOM}\n# ---- asked-for ----\n# Something new.\nRUN true\n`);

    const { items } = await readEnvironmentContents(services);
    const awaiting = items.filter((item) => item.state === "awaiting-approval");
    expect(awaiting.map((item) => item.name)).toEqual(["Asked for"]);
    // The blocks the proposal merely carried forward are not re-offered for approval.
    expect(items.filter((item) => item.name === "Node tools").map((item) => item.state)).toEqual(["active"]);
});

test("a capability's fragment is attributed to the capability that pulled it in", async () => {
    clearVersionCache();
    const services = stubServices([{ id: "postgres", kind: "cli", config: { provider: "postgres", host: "db", user: "u", database: "d" } }]);

    const { items } = await readEnvironmentContents(services);
    const fromCapability = items.filter((item) => item.origin === "capability");
    expect(fromCapability.length).toBeGreaterThan(0);
    expect(fromCapability.every((item) => item.originLabel === "postgres capability")).toBe(true);
});

test("the staples every sandbox ships with are listed, and only where the command answers", async () => {
    clearVersionCache();
    const { items } = await readEnvironmentContents(stubServices());
    const base = items.filter((item) => item.origin === "base");
    expect(base.map((item) => item.name)).toContain("Node.js");
    // Nothing is listed on faith: every base row has a command that answered, and none is pending.
    expect(base.every((item) => item.tools.length === 1 && item.state === "active")).toBe(true);
});

test("a staple the recipe already explains is not listed twice", async () => {
    clearVersionCache();
    const services = stubServices();
    await writeWorkspaceFile(customPath(services), CUSTOM);

    const { items } = await readEnvironmentContents(services);
    // `node` is claimed by the custom block above, so the staples group drops its own Node.js row: the overlay's
    // entry says more about it (it has a rationale, and an owner who approved it).
    expect(items.filter((item) => item.tools.some((tool) => tool.name === "node")).map((item) => item.origin)).toEqual(["custom"]);
});
