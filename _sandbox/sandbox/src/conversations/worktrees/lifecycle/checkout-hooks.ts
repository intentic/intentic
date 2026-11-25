import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import {
    CHECKOUT_HOOKS_FILE,
    type CheckoutHook,
    type CheckoutHookKind,
    CheckoutHooksFileSchema,
} from "@intentic/sandbox-contract/schemas/checkout-hooks";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import type { Logger } from "pino";
import { hookSetApproved } from "../../../guard/hook-approvals.js";
import type { HookSet } from "../../../guard/settings-hooks.js";
import { runCheck } from "../../../workload/run-check.js";

/* A REPOSITORY'S CHECKOUT HOOKS (2026-11-24): `setup` once a conversation's checkout of it is created, before the
 * conversation's turn starts, and `archive` before the checkout is removed, as `.intentic/checkout.json` declares them
 * (sandbox-contract schemas/checkout-hooks.ts). A hook is code a branch can edit and the daemon runs unattended, so it
 * runs only once the owner has approved its exact content: the command and the bytes of every file it runs. That set is
 * filed under Approvals beside the Claude Code hook sets and pinned in the same ledger (guard/hook-approvals.ts), so it
 * is approved, dismissed and revoked through the same cards; a branch that edits the script is a new digest and asks
 * again. An unapproved hook does not run and holds nothing back, or any branch could stall every reclaim by declaring
 * one. An approved archive hook that fails holds an unattended removal back; revoking its approval is the waiver.
 * Hooks run as the daemon, outside the turn's sandbox, with a bare environment (no daemon secrets), and their output
 * is kept in the history volume's logs and told to the next turn. Orca: src/shared/workspace-setup/orca-yaml-hook-types.ts,
 * src/shared/worktree/creation/approved-setup-hashes.ts, src/shared/worktree/removal/archive-hook-removal-gate.ts. */

export interface HookPlace {
    readonly checkout: string;
    readonly main: string;
    readonly repo: string;
    readonly id: string;
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn">;
}

export type HookRun =
    | { readonly outcome: "none" }
    | { readonly outcome: "invalid"; readonly reason: string }
    | { readonly outcome: "held"; readonly digest: string }
    | HookRan;

export interface HookRan {
    readonly outcome: "ok" | "failed";
    readonly digest: string;
    readonly exitCode: number | undefined;
    readonly output: string;
    readonly log: string;
}

const OUTPUT_TAIL = 64 * 1024;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const where = (repo: string, rel: string): string => (repo === "root" ? rel : `${repo}/${rel}`);

// Words of the command that name a file of the checkout (`./scripts/setup.sh`, `bash scripts/setup.sh`): pinned like the
// files the hook lists. A script reached any other way (behind a variable, from another script) is pinned only if listed.
const namedFiles = (command: string): string[] =>
    (command.match(/"[^"]*"|'[^']*'|[^\s;&|()<>]+/gu) ?? [])
        .map((word) => word.replace(/^['"]|['"]$/gu, "").replace(/^\.\//u, ""))
        .filter((word) => word !== "" && !word.startsWith("/") && !word.split("/").includes("..") && !word.startsWith("-"));

/** The set an approval pins for one hook, read from the checkout it would run in. */
export const checkoutHookSet = async (checkout: string, repo: string, kind: CheckoutHookKind, hook: CheckoutHook): Promise<HookSet> => {
    const scripts: { path: string; sha256: string }[] = [];
    for (const rel of [...new Set([...hook.files, ...namedFiles(hook.command)])].toSorted()) {
        const info = await lstat(join(checkout, rel)).catch(undefinedIfMissing);
        if (info?.isFile() === true) {
            scripts.push({ path: where(repo, rel), sha256: sha256(await readFile(join(checkout, rel))) });
        } else if (hook.files.includes(rel)) {
            // A listed file that is missing is part of what was approved too: its appearing later asks again.
            scripts.push({ path: where(repo, rel), sha256: "missing" });
        }
    }
    const hooks = [
        {
            source: "project" as const,
            declaredIn: where(repo, CHECKOUT_HOOKS_FILE),
            event: kind === "setup" ? "When a conversation's checkout of this repository is created" : "Before a conversation's checkout of this repository is removed",
            type: "command",
            run: hook.command,
        },
    ];
    // The kind leads, so the same command declared for setup and for archive is two approvals, not one.
    const digest = sha256(JSON.stringify({ checkoutHook: kind, repo, hooks, scripts, timeoutSeconds: hook.timeoutSeconds }));
    return { digest, hooks, scripts, plugins: [], marketplaces: [] };
};

// The hook as the checkout's own file declares it; a broken file is reported and runs nothing.
const declared = async (checkout: string, kind: CheckoutHookKind): Promise<CheckoutHook | { readonly invalid: string } | undefined> => {
    const text = await readFile(join(checkout, CHECKOUT_HOOKS_FILE), "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return undefined;
    }
    try {
        return CheckoutHooksFileSchema.parse(JSON.parse(text))[kind];
    } catch (error) {
        return { invalid: `${CHECKOUT_HOOKS_FILE} could not be read: ${errorMessage(error)}` };
    }
};

// Runs the command from the checkout's root in its own process group (runCheck); its exit code is undefined when it was
// stopped or never ran.
const execute = async (place: HookPlace, kind: CheckoutHookKind, hook: CheckoutHook): Promise<{ exitCode: number | undefined; output: string }> => {
    const ran = await runCheck({
        argv: ["sh", "-c", hook.command],
        cwd: place.checkout,
        env: {
            PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env["HOME"] ?? "/root",
            LANG: process.env["LANG"] ?? "C.UTF-8",
            INTENTIC_CHECKOUT: place.checkout,
            INTENTIC_MAIN_CHECKOUT: place.main,
            INTENTIC_CONVERSATION: place.id,
            INTENTIC_REPO: place.repo,
            INTENTIC_CHECKOUT_HOOK: kind,
        },
        timeoutMs: hook.timeoutSeconds * 1000,
        workload: { class: "command" },
        kind: "checkout-hook",
        captureBytes: OUTPUT_TAIL,
        keep: "tail",
        interleave: true,
    });
    const stopped = ran.ended === "timeout" ? `\n[stopped after ${hook.timeoutSeconds}s]` : "";
    const failed = ran.spawnError === undefined ? "" : `\n${ran.spawnError}`;
    return { exitCode: ran.exitCode, output: `${ran.stdout}${stopped}${failed}` };
};

/** Runs one repository's `setup` or `archive` hook in a checkout, if it declares one and the owner approved it. */
const runCheckoutHook = async (place: HookPlace, kind: CheckoutHookKind, now: () => number = Date.now): Promise<HookRun> => {
    const hook = await declared(place.checkout, kind);
    if (hook === undefined) {
        return { outcome: "none" };
    }
    if ("invalid" in hook) {
        place.logger.warn({ id: place.id, repo: place.repo, kind }, `agents: ${hook.invalid}`);
        return { outcome: "invalid", reason: hook.invalid };
    }
    const set = await checkoutHookSet(place.checkout, place.repo, kind, hook);
    if (!(await hookSetApproved(place.historyRoot, set, place.id))) {
        place.logger.info({ id: place.id, repo: place.repo, kind, digest: set.digest }, "agents: a checkout hook waits for the owner's approval, not run");
        return { outcome: "held", digest: set.digest };
    }
    const { exitCode, output } = await execute(place, kind, hook);
    const log = join(place.historyRoot, "logs", "checkout-hooks", `${place.id}-${encodeURIComponent(place.repo)}-${kind}-${now()}.log`);
    await mkdir(join(log, ".."), { recursive: true });
    await writeFile(log, `$ ${hook.command}\n${output}\n[exit ${exitCode ?? "none"}]\n`).catch((error) =>
        place.logger.warn({ err: error, log }, "agents: a checkout hook's output could not be kept"),
    );
    const outcome: HookRan["outcome"] = exitCode === 0 ? "ok" : "failed";
    place.logger[outcome === "ok" ? "info" : "warn"]({ id: place.id, repo: place.repo, kind, exitCode, log }, `agents: checkout ${kind} hook ${outcome === "ok" ? "ran" : "failed"}`);
    return { outcome, digest: set.digest, exitCode, output, log };
};

/** An approved archive hook that failed: the checkout stays, as it does for any retire that throws. */
export class ArchiveHookFailed extends Error {
    constructor(
        readonly repo: string,
        readonly run: HookRan,
    ) {
        super(
            `The archive hook of ${repo === "root" ? "the workspace" : repo} (${CHECKOUT_HOOKS_FILE}) exited ${run.exitCode ?? "without a code"}, so the checkout was kept; its output is in ${run.log}. Fix the hook, or revoke its approval under Sandbox ▸ Access ▸ Sandbox-wide permissions to remove the checkout without it.`,
        );
    }
}

// What each conversation's next turn is told about the setup hooks that ran for its new checkout; taken once.
const untold = new Map<string, string[]>();

const tail = (output: string): string => {
    const lines = output.trimEnd().split("\n");
    return lines.slice(-20).join("\n");
};

/** Runs every repository's setup hook in a new composition, root first, and keeps what to tell the conversation. */
export const runSetupHooks = async (places: readonly HookPlace[]): Promise<void> => {
    for (const place of places) {
        const run = await runCheckoutHook(place, "setup");
        const said =
            run.outcome === "ok" || run.outcome === "failed"
                ? `${where(place.repo, CHECKOUT_HOOKS_FILE)}: setup ${run.outcome === "ok" ? "ran" : `failed (exit ${run.exitCode ?? "none"})`}; full output in ${run.log}\n${tail(run.output)}`
                : run.outcome === "held"
                  ? `${where(place.repo, CHECKOUT_HOOKS_FILE)}: a setup hook is declared but the owner has not approved it in this form, so it did not run. The owner approves it under Approvals.`
                  : run.outcome === "invalid"
                    ? `${run.reason}; no setup hook ran.`
                    : undefined;
        if (said !== undefined) {
            untold.set(place.id, [...(untold.get(place.id) ?? []), said]);
        }
    }
};

const CHECKOUT_SETUP_NOTE_TITLE = "Checkout setup";

/** The note for the setup hooks run since the last one was told, clearing them: called once per composed prompt. */
export const takeCheckoutSetupNote = (conversationId: string): TurnNote | undefined => {
    const said = untold.get(conversationId);
    untold.delete(conversationId);
    return said === undefined ? undefined : { title: CHECKOUT_SETUP_NOTE_TITLE, text: said.join("\n\n") };
};

/** Runs each repository's archive hook before its checkout goes; throws ArchiveHookFailed for the first one that fails. */
export const runArchiveHooks = async (places: readonly HookPlace[]): Promise<void> => {
    for (const place of places) {
        if ((await lstat(place.checkout).catch(undefinedIfMissing)) === undefined) {
            continue;
        }
        const run = await runCheckoutHook(place, "archive");
        if (run.outcome === "failed") {
            throw new ArchiveHookFailed(place.repo, run);
        }
    }
};

/** takeCheckoutSetupNote as the prompt's note list takes it (agent/run/stream-agent.ts), told beside the hand-off's. */
export const setupNotesOf = (conversationId: string | undefined): TurnNote[] => {
    const note = conversationId === undefined ? undefined : takeCheckoutSetupNote(conversationId);
    return note === undefined ? [] : [note];
};
