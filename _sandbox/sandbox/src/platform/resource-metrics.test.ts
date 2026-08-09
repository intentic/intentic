import { describe, expect, test } from "vitest";
import { classifyProcess, parseProcStatus } from "./resource-metrics.js";

describe("resource metric process attribution", () => {
    test("parses the memory and ownership fields from proc status", () => {
        expect(
            parseProcStatus(`Name:\tnode
PPid:\t41
VmHWM:\t2048 kB
VmRSS:\t1536 kB
RssAnon:\t1024 kB
RssFile:\t384 kB
RssShmem:\t128 kB
VmSwap:\t256 kB
Threads:\t7
`),
        ).toEqual({
            name: "node",
            ppid: 41,
            rssBytes: 1_572_864,
            rssHighWaterBytes: 2_097_152,
            rssAnonymousBytes: 1_048_576,
            rssFileBytes: 393_216,
            rssSharedBytes: 131_072,
            swapBytes: 262_144,
            threads: 7,
        });
    });

    test.each([
        ["node /opt/typescript-language-server --stdio", "languageServer"],
        ["node /opt/node_modules/@intentic/lsp/dist/cli.js daemon /work", "languageServer"],
        ["node /opt/@playwright/mcp/cli.js", "browser"],
        ["/usr/bin/chromium --headless", "browser"],
        ["/usr/local/bin/codex app-server", "agentRuntime"],
        ["git-fork-broker --socket /run/git.sock", "git"],
        ["cli-proxy-api --port 8317", "translator"],
        ["node extension-backend-host.js", "extension"],
        ["tmux: server", "terminal"],
        ["node dist/main.js", "other"],
    ] as const)("classifies %s as %s", (command, role) => {
        expect(classifyProcess(command)).toBe(role);
    });
});
