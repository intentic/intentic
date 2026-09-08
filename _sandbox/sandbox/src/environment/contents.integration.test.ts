import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { readEnvironmentContents } from "./contents.js";
import { customPath, proposalPath } from "./environment.js";
import { clearVersionCache } from "./version-probe.js";

// End-to-end with real files, capabilities, and probes; asserts versions only on `node` (guaranteed present here),
// everything else by name and grouping, never a version number.

const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

const stubServices = (capabilities: Capability[] = [], environmentHash = ""): Services =>
    unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", {
            sandbox: {
                profile: "container",
                port: 8787,
                host: "0.0.0.0",
                publicUrl: "",
                vm: false,
                grant: "",
                allowUnauthenticated: false,
                environmentHash,
                name: "intentic-sandbox-demo",
                image: "",
                baseImage: "",
                channel: "",
                previousImage: "",
                definitionSeed: "",
                prewarm: false,
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

// A block whose command is guaranteed present (node) and one whose command cannot be.
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

    const present = custom[0];
    expect(present?.state).toBe("active");
    expect(present?.tools.map((tool) => tool.name)).toContain("node");
    expect(present?.tools.find((tool) => tool.name === "node")?.version).toBe(process.version.slice(1));
    expect(present?.purpose?.length).toBeGreaterThan(0);
    // `detail` carries the whole comment, not comment-minus-purpose, avoiding a doubled opening sentence.
    expect(present?.detail?.startsWith(present?.purpose ?? "")).toBe(true);
    expect(present?.detail?.length ?? 0).toBeGreaterThan(present?.purpose?.length ?? 0);
    expect(present?.commands).toBe("RUN echo pretend-install && node --version");

    // Derived from the probe, not a hash comparison, so "after-rebuild" is per-item, not per-card.
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
    // Carried-forward blocks are not re-offered for approval; only the new ones are.
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
    expect(base.every((item) => item.tools.length === 1 && item.state === "active")).toBe(true);
});

test("a staple the recipe already explains is not listed twice", async () => {
    clearVersionCache();
    const services = stubServices();
    await writeWorkspaceFile(customPath(services), CUSTOM);

    const { items } = await readEnvironmentContents(services);
    expect(items.filter((item) => item.tools.some((tool) => tool.name === "node")).map((item) => item.origin)).toEqual(["custom"]);
});
