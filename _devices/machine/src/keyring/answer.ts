import { errorMessage } from "@intentic/base/errors";
import { KeyringUnavailable } from "@intentic/keyring";
import { explain, type Ui } from "@intentic/local-agent";
import type { CommandContext } from "@stricli/core";
import { answeringUi, markFailed } from "../cli-ui.js";
import { type KeyringCliCode, KeyringCliError } from "./flags.js";

// WHAT EVERY `intentic-machine keyring …` COMMAND PRINTS. With --json, exactly one line on stdout: `{"ok":true,…}`, or
// `{"ok":false,"code":…,"refusal":…}` with exit code 1, `code` being the keyring's own refusal code (no-keyring, locked,
// declined, …) or `usage`/`failed` for what went wrong here. The desktop app reads these field by field, so fields are
// only ever added. Without it, the protocol's live line and report (cli-ui.ts), and a failure as its stop.

export interface Refusal {
    readonly ok: false;
    readonly code: KeyringCliCode;
    readonly refusal: string;
}

export interface Words {
    // The live line while the work runs, in the present tense; none for a read.
    readonly doing?: string;
    // The stop's headline when it does not land.
    readonly failed: string;
}

// A stop composed with explain, as the one run of sentences a JSON reader shows.
const flat = (message: string): string =>
    message
        .split("\n")
        .map((line) => line.replace(/^\s*(?:problem|fix):\s*/u, "").trim())
        .filter((line) => line !== "")
        .join(" ");

// A reason as a stop's `problem:`, or the whole stop where it was composed as one already.
const asStop = (failed: string, message: string): string => (message.includes("\n   problem: ") ? message : explain(failed, message));

// A keyring's no is a refusal of this file's own shape (its code is one of KeyringCliCode's); a yes is whatever the
// command answers. Told apart by `ok`, the one field both carry.
const refused = <A extends { readonly ok: boolean }>(answer: A | Refusal): answer is Refusal => !answer.ok;
const granted = <A extends { readonly ok: boolean }>(answer: A | Refusal): answer is Extract<A, { readonly ok: true }> => answer.ok;

export const keyringAnswer = async <A extends { readonly ok: boolean }>(
    cli: CommandContext,
    json: boolean,
    words: Words,
    work: (ui: Ui) => Promise<A | Refusal>,
    human: (result: Extract<A, { readonly ok: true }>, ui: Ui) => void,
): Promise<void> => {
    const ui = answeringUi(cli.process, json);
    if (!json && words.doing !== undefined) {
        ui.act(words.doing);
    }
    let result: A | Refusal;
    try {
        result = await work(ui);
    } catch (error) {
        // A step here that failed says which: a refusal of this command's own, no keyring answering, or anything else.
        const code: KeyringCliCode = error instanceof KeyringCliError ? error.code : error instanceof KeyringUnavailable ? "no-keyring" : "failed";
        result = { ok: false, code, refusal: errorMessage(error) };
    }
    if (refused(result)) {
        if (!json) {
            throw new KeyringCliError(result.code, asStop(words.failed, result.refusal));
        }
        ui.close();
        // allow(terminal-output): the --json refusal the desktop app reads
        cli.process.stdout.write(`${JSON.stringify({ ok: false, code: result.code, refusal: flat(result.refusal) })}\n`);
        markFailed(cli);
        return;
    }
    if (!granted(result)) {
        return;
    }
    if (json) {
        ui.close();
        // allow(terminal-output): the --json answer the desktop app reads
        cli.process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    human(result, ui);
};
