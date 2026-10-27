import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { unstubbed } from "@intentic/testing";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CapabilityCtx } from "../../capability.js";
import { contributionRegistry } from "../../contributions.js";
import type { ExtensionHost } from "../../extension-inventory/installed-extensions.js";
import { cliHandler } from "../../handlers/cli.handler.js";
import { createTerminalRunner } from "../../../terminal/terminal-run.js";
import { fileSshKeyStore } from "../../ssh-key-store.js";
import { makeWorkspaceDir, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../../workspace/files/workspace-files.js";

export const cardHost = (root: string, card: Capability): ExtensionHost => ({
    workspace: { root },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [card] },
    config: { extensionsDir: join(repoRoot(import.meta.url), "_extensions"), historyRoot: join(root, "history") },
});

export const loadCard = async (host: ExtensionHost, provider: string) => {
    const registry = await contributionRegistry(host);
    const contribution = registry.get(`cli:${provider}`);
    if (contribution === undefined) {
        throw new Error(`no real manifest contribution for cli:${provider}`);
    }
    return { registry, contribution };
};

// Apply the real handler with account hooks disabled; git scenarios exercise those hooks separately.
export const installSkill = async (host: ExtensionHost, card: Capability): Promise<string> => {
    if (card.kind !== "cli") {
        throw new Error("conformance skill install requires a CLI card");
    }
    const { contribution } = await loadCard(host, card.config.provider);
    const config = { ...card.config };
    if (contribution.spec.kind === "cli" && contribution.spec.fields.some((field) => field.key === "git")) {
        config["git"] = "off";
    }
    const ctx = unstubbed<CapabilityCtx>("conformance capability", {
        workspace: unstubbed<CapabilityCtx["workspace"]>("workspace", host.workspace),
        files: unstubbed<CapabilityCtx["files"]>("files", {
            write: writeWorkspaceFile,
            read: readWorkspaceFile,
            remove: removeWorkspacePath,
            mkdir: makeWorkspaceDir,
        }),
        capabilities: unstubbed<CapabilityCtx["capabilities"]>("capabilities", host.capabilities),
        extensionsDir: host.config.extensionsDir,
        historyRoot: host.config.historyRoot,
        terminalRun: createTerminalRunner(),
        sshKeys: fileSshKeyStore(join(host.workspace.root, "keys")),
    });
    for await (const line of cliHandler.apply(ctx, card.id, config)) {
        void line;
        // Drain the handler's progress stream.
    }
    return readFile(join(host.workspace.root, ".agents", "skills", card.id, "SKILL.md"), "utf8");
};

// Select a fenced helper from the installed skill, after the daemon rewrites its environment names.
export const skillCodeBlock = (skill: string, language: string, index = 0): string => {
    const blocks = [...skill.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gmu)].filter((block) => block[1] === language);
    const code = blocks[index]?.[2];
    if (code === undefined) {
        throw new Error(`SKILL.md has no ${language} code block at index ${String(index)}`);
    }
    return code;
};

export const skillCommand = (skill: string, label: string, placeholders: Readonly<Record<string, string>> = {}, index = 0): string => {
    const line = skill.split("\n").find((entry) => entry.startsWith(`- ${label}: `));
    const command = [...(line?.slice(`- ${label}: `.length).matchAll(/`([^`]+)`/gu) ?? [])][index]?.[1];
    if (command === undefined) {
        throw new Error(`SKILL.md has no inline command labelled "${label}"`);
    }
    let filled = command;
    for (const [key, value] of Object.entries(placeholders)) {
        if (!/^[A-Za-z0-9._/-]+$/u.test(value)) {
            throw new Error(`unsafe skill placeholder ${key}`);
        }
        filled = filled.replaceAll(`<${key}>`, value);
    }
    if (/<[A-Z_]+>/u.test(filled)) {
        throw new Error(`unfilled placeholder in "${label}"`);
    }
    return filled;
};
