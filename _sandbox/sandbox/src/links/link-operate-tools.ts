import { LINK_EXEC_TIMEOUT_S_DEFAULT, LINK_EXEC_TIMEOUT_S_MAX, LINK_OPERATE_WAIT_S_MAX, type LinkExecStatus } from "@intentic/sandbox-contract/schemas/links";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { sleep } from "@intentic/base/async";
import { z } from "zod";
import { sdk } from "../engines/claude-sdk.js";
import { opt } from "../opt.js";
import { linkExec, linkExecStatus, linkExecStop, linkFileRead, linkFileWrite, type LinkTarget } from "../sandboxes/link-client.js";

// OPERATING A LINKED SANDBOX, the asking side (schemas/links.ts `operate`): `run_command`, `read_file` and `write_file`
// on the link's tool server, beside `delegate`. They act over there as that sandbox's owner does in their own terminal,
// in its main checkout, which a delegated task cannot: its turn works in a checkout of its own (link-operate.ts). The far
// side decides whether the link may operate it; this side only keeps a turn that may not hand work on from operating
// another sandbox either.

type LinkCard = Extract<Capability, { kind: "link" }>;
// A type, not an interface: the SDK's result type wants the implicit index signature only an alias carries.
type ToolAnswer = { content: { type: "text"; text: string }[] };

const answer = <Payload extends object>(payload: Payload): ToolAnswer => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

// What one stream of a command is shown as: its end, since that is where a failure says what it was.
const STREAM_SHOWN = 15_000;
// A read answered at length is cut so the answer stays readable; `offset` reads on.
const CONTENT_SHOWN = 30_000;
// How long the asking side follows a command past its own deadline: the far side ends it there, and says so.
const FOLLOW_GRACE_S = 30;
// How many times in a row a read of a running command may find the far side unreachable before the tool gives up on it.
const UNREACHED_TRIES = 3;

const CallExtraSchema = z.object({ signal: z.instanceof(AbortSignal) });

const tail = (text: string, chars: number): string => (text.length > chars ? `… (${text.length - chars} characters cut)\n${text.slice(-chars)}` : text);

// A command's settled answer as the model reads it: `ok` is whether it ran and ended on its own with exit 0.
const commandAnswer = (status: LinkExecStatus): ToolAnswer =>
    answer({
        ok: status.state === "exited" && status.exitCode === 0,
        state: status.state,
        ...opt("exitCode", status.exitCode),
        ...opt("signal", status.signal),
        stdout: tail(status.stdout, STREAM_SHOWN),
        stderr: tail(status.stderr, STREAM_SHOWN),
        ...opt("truncated", status.truncated ? true : undefined),
        ...opt("error", status.error),
        cwd: status.cwd,
        jailed: status.jailed,
        ...opt("id", status.state === "running" ? status.id : undefined),
    });

// Follows a command over there until it ends, its deadline (plus grace) passes, or this call is stopped, which stops it.
type Followed = { readonly ok: true; readonly status: LinkExecStatus } | { readonly ok: false; readonly message: string };

const follow = async (target: LinkTarget, first: LinkExecStatus, timeoutS: number, signal: AbortSignal | undefined): Promise<Followed> => {
    let status = first;
    let unreached = 0;
    const deadline = Date.now() + (timeoutS + FOLLOW_GRACE_S) * 1_000;
    while (status.state === "running" && Date.now() < deadline) {
        if (signal?.aborted === true) {
            const stopped = await linkExecStop(target, status.id);
            return { ok: true, status: stopped.ok ? stopped.value : status };
        }
        const next = await linkExecStatus(target, status.id, LINK_OPERATE_WAIT_S_MAX, signal);
        if (next.ok) {
            status = next.value;
            unreached = 0;
            continue;
        }
        // No answer at all (a dropped connection, a stopped call) is tried again; a refusal is the far side's word.
        if (next.status !== 0 || ++unreached >= UNREACHED_TRIES) {
            return { ok: false, message: next.message };
        }
        await sleep(2_000, { signal });
    }
    return { ok: true, status };
};

const operateWords = (sandbox: string) => ({
    where:
        `It acts as "${sandbox}"'s owner does in their own terminal: in that sandbox's main checkout (the workspace root ` +
        "every conversation there lands into, never a conversation's own worktree), as root, or, while its conversations can " +
        "be private, inside the jail every person's shell gets there, which hides its history volume (`jailed` in the answer says which).",
    allowed: `Only while "${sandbox}"'s owner lets this link operate it (\`about\` says whether); every call is logged over there.`,
});

const NOT_HERE =
    "This turn may not operate another sandbox: it was started by outside content, or its persona does not delegate. Do the work here, or say what you left undone.";

/** The operating tools of one linked sandbox's server; `may` says whether this turn may act on another sandbox at all. */
export const operateTools = (card: LinkCard, sandbox: string, conversationId: string | undefined, may: () => boolean) => {
    const target: LinkTarget = { id: card.id, config: card.config };
    const { where, allowed } = operateWords(sandbox);
    const from = { ...opt("conversation", conversationId) };
    const refusal = (message: string): ToolAnswer => answer({ ok: false, message: `"${sandbox}": ${message}` });
    return [
        sdk().tool(
            "run_command",
            `Run a shell command (bash, as a login shell) in the linked sandbox "${sandbox}" and get back its exit code, stdout and stderr. ${where} ` +
                "Use it to look into or repair that sandbox itself: its git state, its files, its processes, its own `agents` and `diagnostics` commands. " +
                `A command that outlives the call is followed until it ends or its timeout. ${allowed}`,
            {
                command: z.string().min(1).describe("The command line."),
                cwd: z.string().min(1).optional().describe("Where it runs over there: absolute, or relative to its workspace root (the default)."),
                timeoutSeconds: z
                    .number()
                    .int()
                    .min(1)
                    .max(LINK_EXEC_TIMEOUT_S_MAX)
                    .optional()
                    .describe(`How long it may run before it is stopped. Default ${LINK_EXEC_TIMEOUT_S_DEFAULT}.`),
            },
            async ({ command, cwd, timeoutSeconds }, extra) => {
                if (!may()) {
                    return answer({ ok: false, message: NOT_HERE });
                }
                const signal = CallExtraSchema.safeParse(extra).data?.signal;
                const timeoutS = timeoutSeconds ?? LINK_EXEC_TIMEOUT_S_DEFAULT;
                const started = await linkExec(target, { command, ...opt("cwd", cwd), timeoutS, waitS: LINK_OPERATE_WAIT_S_MAX, from }, signal);
                if (!started.ok) {
                    return refusal(started.message);
                }
                const settled = await follow(target, started.value, timeoutS, signal);
                return settled.ok ? commandAnswer(settled.status) : refusal(`the command was started (id ${started.value.id}) but could not be followed: ${settled.message}`);
            },
            // Runs anything, as that sandbox's owner, which nothing here can take back.
            { annotations: toolAnnotations("destructive") },
        ),
        sdk().tool(
            "read_file",
            `Read a text file in the linked sandbox "${sandbox}", by lines, or list a directory there. ${where} ${allowed}`,
            {
                path: z.string().min(1).describe("Absolute, or relative to its workspace root."),
                offset: z.number().int().min(1).optional().describe("The line to start from, counting from 1."),
                limit: z.number().int().min(1).max(20_000).optional().describe("How many lines. Default 2000."),
            },
            async ({ path, offset, limit }, extra) => {
                if (!may()) {
                    return answer({ ok: false, message: NOT_HERE });
                }
                const read = await linkFileRead(target, { path, ...opt("offset", offset), ...opt("limit", limit), from }, CallExtraSchema.safeParse(extra).data?.signal);
                if (!read.ok) {
                    return refusal(read.message);
                }
                const cut = read.value.content.length > CONTENT_SHOWN;
                return answer({
                    ok: true,
                    ...read.value,
                    content: cut ? `${read.value.content.slice(0, CONTENT_SHOWN)}\n… (cut: read on with offset)` : read.value.content,
                    truncated: read.value.truncated || cut,
                });
            },
            { annotations: toolAnnotations("read") },
        ),
        sdk().tool(
            "write_file",
            `Create or replace a whole text file in the linked sandbox "${sandbox}", making its folders as needed. ${where} Read it first: nothing here merges. ${allowed}`,
            {
                path: z.string().min(1).describe("Absolute, or relative to its workspace root."),
                content: z.string().describe("The file's whole new contents."),
            },
            async ({ path, content }, extra) => {
                if (!may()) {
                    return answer({ ok: false, message: NOT_HERE });
                }
                const written = await linkFileWrite(target, { path, content, from }, CallExtraSchema.safeParse(extra).data?.signal);
                return written.ok ? answer({ ok: true, ...written.value }) : refusal(written.message);
            },
            { annotations: toolAnnotations("destructive") },
        ),
    ];
};
