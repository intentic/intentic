import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentDrift, RuntimeInstall } from "@intentic/sandbox-contract/schemas/environment";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { AUTO_MARKER, autoDraftedTools, draftFileName, named, stepFor, synthesizeAutoDrafts } from "./auto-drafts.js";
import { fileRuntimeInstallsStore } from "./runtime-installs.js";

const workspace = () => {
    const root = mkdtempSync(join(tmpdir(), "auto-drafts-"));
    return { workspace: { root }, files: { read: readWorkspaceFile, write: writeWorkspaceFile } };
};

const entry = (over: Partial<RuntimeInstall> = {}): RuntimeInstall => ({
    tool: "p7zip-full",
    kind: "apt",
    sessions: ["s1", "s2"],
    commands: ["apt-get install -y p7zip-full"],
    firstAt: Date.parse("2026-08-15T00:00:00Z"),
    lastAt: Date.parse("2026-08-25T00:00:00Z"),
    count: 3,
    ...over,
});

// apt corroboration reads the drift snapshot alone, which is what makes the synthesis loop provable without
// faking a filesystem; the stat-based kinds are the sweep's own business.
const DRIFT: EnvironmentDrift = { bornAt: 0, at: 0, apt: ["p7zip-full"], paths: [] };

const customPath = (root: string) => join(root, ".intentic/config/environment.custom.Dockerfile");
const draftsPath = (root: string, tool: string) => join(root, ".intentic/config/environment.d", `${tool}.Dockerfile`);

test("a recurring, corroborated, templatable install earns a frozen draft", async () => {
    const deps = workspace();
    const drafted = await synthesizeAutoDrafts(deps, { installs: [entry()] }, DRIFT);
    expect(drafted).toEqual(["p7zip-full"]);
    const content = (await readWorkspaceFile(draftsPath(deps.workspace.root, "p7zip-full")))!;
    expect(content.split("\n")[0]).toBe(`${AUTO_MARKER} p7zip-full`);
    // The step follows the overlay house rules: both apt cache mounts, lists kept.
    expect(content).toContain("--mount=type=cache,target=/var/cache/apt,sharing=locked");
    expect(content).toContain("--mount=type=cache,target=/var/lib/apt/lists,sharing=locked");
    expect(content).toContain("apt-get install -y --no-install-recommends p7zip-full");
    // Provenance, so the owner reads WHY, not just WHAT.
    expect(content).toContain("installed at runtime twice");
    // A second pass changes nothing: the draft is frozen once written.
    expect(await synthesizeAutoDrafts(deps, { installs: [entry({ sessions: ["s1", "s2", "s3"] })] }, DRIFT)).toEqual([]);
    expect(await readWorkspaceFile(draftsPath(deps.workspace.root, "p7zip-full"))).toBe(content);
});

test.each<[string, RuntimeInstall, EnvironmentDrift]>([
    ["one session is an experiment, not a habit", entry({ sessions: ["s1"] }), DRIFT],
    ["no corroboration: the ledger says installed, the container disagrees", entry(), { ...DRIFT, apt: [] }],
    ["declined by the owner: never proposed again", entry({ declinedAt: 1 }), DRIFT],
    ["no mechanical template for its kind", entry({ kind: "pip", tool: "pillow" }), { ...DRIFT, paths: ["/usr/local/lib/python3/pillow"] }],
])("no draft when %s", async (_reason, install, drift) => {
    const deps = workspace();
    expect(await synthesizeAutoDrafts(deps, { installs: [install] }, drift)).toEqual([]);
    expect(await readdir(join(deps.workspace.root, ".intentic/config/environment.d")).catch(() => [])).toEqual([]);
});

test("a tool the custom section already bakes is not proposed again", async () => {
    const deps = workspace();
    await writeWorkspaceFile(
        customPath(deps.workspace.root),
        "# ---- p7zip ----\nRUN apt-get update && apt-get install -y p7zip-full\n",
    );
    expect(await synthesizeAutoDrafts(deps, { installs: [entry()] }, DRIFT)).toEqual([]);
});

test("a pinned spec in the custom section names its package", async () => {
    const deps = workspace();
    await writeWorkspaceFile(
        customPath(deps.workspace.root),
        "# ---- opencode ----\nRUN npm install -g @opencode/cli@2.1.4\n",
    );
    expect(await synthesizeAutoDrafts(deps, { installs: [entry({ kind: "npm", tool: "@opencode/cli" })] }, DRIFT)).toEqual([]);
    expect(named("RUN npm install -g @opencode/cli-linux-x64@2.1.4", "@opencode/cli")).toBe(false);
});

test.each([String.raw`tool\name`, "tool[", "tool(foo)", "tool|other", "tool.*", "tool+name", "tool$name", "tool^name", "tool{name}", "tool?name"])(
    "tool names containing regex syntax match literally: %s",
    (tool) => {
        expect(named(`RUN install ${tool}`, tool)).toBe(true);
        expect(named(`RUN install ${tool}@latest`, tool)).toBe(true);
        expect(named(`RUN install prefix-${tool}-suffix`, tool)).toBe(false);
        expect(named("RUN install unrelated", tool)).toBe(false);
    },
);

test("a tool name cannot impersonate another installed package", () => {
    expect(named("RUN install toolname", String.raw`tool\name`)).toBe(false);
    expect(named("RUN install other", "tool|other")).toBe(false);
    expect(named("RUN install toolZZ", "tool.*")).toBe(false);
});

test("an agent's own draft under the same name is left exactly as written", async () => {
    const deps = workspace();
    const path = draftsPath(deps.workspace.root, "p7zip-full");
    await writeWorkspaceFile(path, "RUN apt-get update && apt-get install -y p7zip-full p7zip-rar\n");
    expect(await synthesizeAutoDrafts(deps, { installs: [entry()] }, DRIFT)).toEqual([]);
    expect(await readWorkspaceFile(path)).toContain("p7zip-rar");
});

test("autoDraftedTools names machine drafts and leaves agent drafts alone", async () => {
    const deps = workspace();
    await synthesizeAutoDrafts(deps, { installs: [entry()] }, DRIFT);
    await writeWorkspaceFile(draftsPath(deps.workspace.root, "ffmpeg"), "RUN apt-get install -y ffmpeg\n");
    expect(await autoDraftedTools(deps)).toEqual(["p7zip-full"]);
});

test("the sweep end to end: ledger recurrence in, owner-reviewable draft out", async () => {
    const deps = workspace();
    const ledger = fileRuntimeInstallsStore(join(deps.workspace.root, ".intentic/local/runtime-installs.json"));
    await ledger.record([{ kind: "apt", tool: "p7zip-full" }], "apt-get install -y p7zip-full", "s1", 1_000);
    await ledger.record([{ kind: "apt", tool: "p7zip-full" }], "apt-get install -y -qq p7zip-full", "s2", 2_000);
    const drafted = await synthesizeAutoDrafts(deps, await ledger.read(), DRIFT);
    expect(drafted).toEqual(["p7zip-full"]);
});

/* The templates, pinned: these strings end up in front of the owner and then in the image. */

test.each<[Parameters<typeof stepFor>[0], string]>([
    [{ kind: "cargo", tool: "cargo-xwin" }, "RUN cargo install --locked cargo-xwin"],
    [{ kind: "rustup-target", tool: "x86_64-pc-windows-msvc" }, "RUN rustup target add x86_64-pc-windows-msvc"],
    [{ kind: "npm", tool: "typescript" }, "RUN --mount=type=cache,target=/root/.npm \\\n    npm install -g typescript"],
])("the mechanical step for %o", (install, expected) => {
    expect(stepFor(install)).toBe(expected);
});

/* The browser pack must preserve the cache mount required by a workspace e2e suite. */
test("a playwright browser drafts a step, and does not mount the cache the download has to land in", () => {
    const step = stepFor({ kind: "playwright", tool: "chromium-headless-shell" })!;
    expect(step).toContain("npx --yes playwright install --with-deps chromium-headless-shell");
    expect(step).toContain("--mount=type=cache,target=/root/.npm");
    expect(step).not.toContain("target=/root/.cache/ms-playwright");
});

test.each<[Parameters<typeof stepFor>[0]]>([[{ kind: "pip", tool: "pillow" }], [{ kind: "other", tool: "bun.sh" }], [{ kind: "go", tool: "gopls" }]])(
    "no mechanical step for %o — surfaced, not drafted",
    (install) => {
        expect(stepFor(install)).toBeUndefined();
    },
);

test("draft file names are deterministic and filesystem-boring", () => {
    expect(draftFileName("p7zip-full")).toBe("p7zip-full.Dockerfile");
    expect(draftFileName("@openai/codex")).toBe("openai-codex.Dockerfile");
    expect(draftFileName("x86_64-pc-windows-msvc")).toBe("x86_64-pc-windows-msvc.Dockerfile");
    expect(draftFileName("///")).toBeUndefined();
});
