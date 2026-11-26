import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { extensionGatewayUrlFile } from "@intentic/sandbox-contract/workspace-state";
import { declaredMessageLimit, findWorkspaceRoot, readGatewayUrl } from "./workspace.js";

// A temp tree standing in for /work: the workspace's own .intentic, a repository inside it carrying an .intentic of
// its own (as this repository does), and a directory deep in that repository where the agent stands.
let root: string;
let repoDir: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "connector-workspace-"));
    repoDir = join(root, "repo", "src", "deep");
    await mkdir(repoDir, { recursive: true });
    await mkdir(dirname(join(root, extensionGatewayUrlFile("whatsapp"))), { recursive: true });
    await mkdir(join(root, "repo", STATE_DIR), { recursive: true });
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

test("the declared workspace wins over anything the walk would find", () => {
    expect(findWorkspaceRoot({ INTENTIC_WORKSPACE: "/declared" }, repoDir)).toBe("/declared");
});

test("the walk stops at the nearest directory holding the probe, and falls back to WORKSPACE_ROOT past the top", () => {
    expect(findWorkspaceRoot({}, repoDir)).toBe(join(root, "repo"));
    expect(findWorkspaceRoot({ WORKSPACE_ROOT: "/fallback" }, repoDir, "no-such-file")).toBe("/fallback");
});

test("a gateway's address is found from inside a repository that has an .intentic of its own", async () => {
    await writeFile(join(root, extensionGatewayUrlFile("whatsapp")), "http://127.0.0.1:4321\n");
    expect(await readGatewayUrl("whatsapp", {}, repoDir)).toBe("http://127.0.0.1:4321");
});

test("no published address reads as a gateway not running yet", async () => {
    expect(await readGatewayUrl("discord", { WORKSPACE_ROOT: root }, repoDir)).toBeUndefined();
});

// A gateway's ceiling is its own card's declaration, read from the manifest beside it; one that declares none cannot run.
describe("declaredMessageLimit", () => {
    const manifestOf = (extension: string): URL => pathToFileURL(join(repoRoot(import.meta.url), "_extensions", extension, "intentic-extension.json"));

    test("reads the limit each chat card declares", () => {
        expect(declaredMessageLimit(manifestOf("discord"), "discord")).toBe(2_000);
        expect(declaredMessageLimit(manifestOf("slack"), "slack")).toBe(4_000);
        expect(declaredMessageLimit(manifestOf("telegram"), "telegram")).toBe(4_096);
        expect(declaredMessageLimit(manifestOf("whatsapp"), "whatsapp")).toBe(65_536);
    });

    test("refuses a card that declares none, or one the manifest does not have, naming it", () => {
        expect(() => declaredMessageLimit(manifestOf("imap"), "imap")).toThrow(`the "imap" card in`);
        expect(() => declaredMessageLimit(manifestOf("discord"), "slack")).toThrow("declares no channel.messageLimit");
    });
});
