import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { maskCredentialMaterial, SECRET_REFERENCE } from "@intentic/sandbox-contract";
import { maskDeep, type MaskTarget, maskTargets, namesCredentialMaterial, withheld } from "../../../agent/tools/agent-redaction.js";
import { type ResolvedCommand, resolveCommandSecrets, type SecretAccess } from "../../../secrets/secret-access.js";

// The sandbox's stored secrets on a Cursor turn (agent-runtimes.ts `secrets: "shell"`). Every shell command runs through
// the hook script (cursor-hooks.ts), so the daemon holds the line between the model and the shell both ways:
// - a `{{secret:name}}` reference in a command is resolved to its value once the owner's rules let the command run, the
//   release cards answered, in what the script runs and never in what Cursor records;
// - what the command prints is masked back to the references before Cursor reads it;
// - a file Cursor's read tool would open is refused when it holds a stored value, since a read can be refused but not
//   changed, and the model is pointed at the shell, where the same file arrives masked;
// - what the daemon's own custom tools answer is masked in their handlers.
// What it does not cover, and why the value is not "masked": the lines grep and list hand back, an MCP server's result,
// and an edit's echo reach the model as Cursor read them.

export interface CursorSecrets {
    // The command with its references resolved, or the refusal (an unknown name, a release someone declined).
    readonly resolve: (command: string) => Promise<ResolvedCommand>;
    // What a command printed, masked. `aimed` is a command that names credential material (a key file, a vault), whose
    // output is also masked by shape, as the Claude loop's PostToolUse redaction does. Throws when the stores can't be read.
    readonly mask: (output: string, aimed: boolean) => Promise<string>;
    // Whether a command names credential material, read off the command as the model wrote it.
    readonly aimed: (command: string) => boolean;
    // Whether a file's text holds a stored value (or, at a credential path, credential material by its shape). Throws
    // when the stores can't be read, which the hook turns into a refusal.
    readonly holds: (path: string, content: string | undefined) => Promise<boolean>;
}

// How long one reading of the stores answers for. A command's output arrives a stretch at a time, a few a second while
// it prints; reading every store for each would cost more than the command. A value stored mid-command is masked from
// the next reading on.
const TARGETS_FOR_MS = 2_000;

/** Said for a read of a file that holds a stored value. */
export const secretReadRefusal = (path: string): string =>
    `${path} holds the value of a secret stored in this sandbox, so the read tool may not open it: the value would reach the model as it is. ` +
    "Read it with the shell (cat, sed -n, head) instead, where every stored value comes back as its {{secret:name}} reference.";

/** Said for a whole-file write over a file that holds a stored value, whose result would echo what it replaced. */
export const secretWriteRefusal = (path: string): string =>
    `${path} holds the value of a secret stored in this sandbox, so it may not be written whole: the write would hand its old contents back as they are. ` +
    "Change it with the shell (sed -i, a heredoc) instead, and write {{secret:name}} where a stored value goes.";

// Every reference in a command, which says which stored value goes where and is no credential material of its own: left
// in, a command that only names one reads as handling credentials, and the shape pass blanks the reference it prints.
const REFERENCES = new RegExp(SECRET_REFERENCE.source, "gu");

const maskText = (text: string, targets: readonly MaskTarget[]): string =>
    // SAFETY: maskDeep maps a string to a string; only arrays and objects come back as anything else.
    maskDeep(text, targets) as string;

export const cursorSecrets = (access: SecretAccess): CursorSecrets => {
    let cached: { readonly at: number; readonly targets: Promise<readonly MaskTarget[]> } | undefined;
    const targets = async (): Promise<readonly MaskTarget[]> => {
        const now = Date.now();
        if (cached === undefined || now - cached.at > TARGETS_FOR_MS) {
            const reading = access.list().then(maskTargets);
            cached = { at: now, targets: reading };
            // A failed reading is not kept: the next stretch reads again rather than failing for two seconds.
            void reading.catch(() => {
                if (cached?.targets === reading) {
                    cached = undefined;
                }
            });
        }
        return cached.targets;
    };
    return {
        resolve: (command) => resolveCommandSecrets(command, access, "shell", "Shell"),
        mask: async (output, aimed) => {
            const masked = maskText(output, await targets());
            return aimed ? maskCredentialMaterial(masked) : masked;
        },
        aimed: (command) => namesCredentialMaterial({ command: command.replaceAll(REFERENCES, "") }),
        holds: async (path, content) => {
            if (content === undefined || content === "") {
                return false;
            }
            if (maskText(content, await targets()) !== content) {
                return true;
            }
            return namesCredentialMaterial({ file_path: path }) && maskCredentialMaterial(content) !== content;
        },
    };
};

/** The daemon's custom tools with what they answer masked: a script's output, a child's report. Fails closed. */
export const secretMaskedCustomTools = (tools: Record<string, SDKCustomTool>, access: SecretAccess): Record<string, SDKCustomTool> =>
    Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [
            name,
            {
                ...tool,
                execute: async (args, context) => {
                    const result = await tool.execute(args, context);
                    try {
                        // SAFETY: maskDeep keeps a value's shape, only its strings change, so a result stays a result.
                        return maskDeep(result, maskTargets(await access.list())) as SDKCustomToolResult;
                    } catch (error) {
                        return withheld(error);
                    }
                },
            } satisfies SDKCustomTool,
        ]),
    );
