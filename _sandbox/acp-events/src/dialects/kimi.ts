import type { ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";
import { opt } from "../opt.js";
import { type AcpDialect, plainReader } from "./dialect.js";

// Moonshot's Kimi Code CLI (`kimi acp`). Written against 2.1.1, the engine store's pin (runtimes/kimi-cli), its shell
// result read off that release's own source (dist/main.mjs, `foregroundCompletionResult`), the reading itself after
// Orca's (github.com/stablyai/orca at 5127e857010, src/main/acp/acp-dialects/kimi-dialect.ts, MIT). Kimi speaks plain
// ACP otherwise: its ask-user tool asks through form elicitation, its subagents and background tasks are ordinary calls.
// - A shell call's rawOutput is one string: the output, then `Command failed with exit code: N.` on a failing exit, or
//   only `Command executed successfully.` when a passing command printed nothing. The exit is read into `exitCode`.
// - While a call runs, its text content is the arguments it streams, not output: the card keeps its input instead.

const SHELL_FAILURE = /^(?:([\s\S]*)\n)?Command failed with exit code: (-?\d+)\.$/u;
const SHELL_SILENT_SUCCESS = "Command executed successfully.";

const isText = (block: ToolCallContent): boolean => block.type === "content" && block.content.type === "text";

// The command's own output and exit, from the one string Kimi answers a shell call with; null for any other answer.
const shellResult = (output: string, status: ToolCallUpdate["status"]): { readonly stdout: string; readonly exitCode: number } | null => {
    if (status === "completed") {
        return output === SHELL_SILENT_SUCCESS ? { stdout: "", exitCode: 0 } : null;
    }
    const failure = status === "failed" ? SHELL_FAILURE.exec(output) : null;
    if (failure === null) {
        return null;
    }
    const exitCode = Number(failure[2]);
    const stdout = failure[1] ?? "";
    // With nothing printed Kimi writes this line itself; it is not the command's output.
    return { stdout: stdout === `Process exited with code ${String(exitCode)}` ? "" : stdout, exitCode };
};

const normalizeToolUpdate = (update: ToolCallUpdate): ToolCallUpdate => {
    if (update.status === "pending" || update.status === "in_progress") {
        return update.content == null ? update : { ...update, content: update.content.filter((block) => !isText(block)) };
    }
    const output = z.string().safeParse(update.rawOutput).data;
    const shell = output === undefined ? null : shellResult(output, update.status);
    if (shell === null) {
        return update;
    }
    const content = update.content?.flatMap((block): ToolCallContent[] => {
        if (!(block.type === "content" && block.content.type === "text" && block.content.text === output)) {
            return [block];
        }
        return shell.stdout === "" ? [] : [{ type: "content", content: { type: "text", text: shell.stdout } }];
    });
    return { ...update, rawOutput: shell, ...opt("content", content) };
};

export const KIMI_DIALECT: AcpDialect = {
    id: "kimi",
    writtenAgainst: "Kimi Code CLI 2.1.1 (engine pin), read off its source; no traffic recorded",
    reader: plainReader,
    normalizeToolUpdate,
};
