import { readFile } from "node:fs/promises";
import type { Consent, ConsentAnswer, ConsentRequest } from "../../consent/consent.js";
import type { Runner } from "../../run.js";
import { POLKIT_ACTION } from "./paths-linux.js";
import type { ServiceKey } from "../service-key.js";

// A YES ON LINUX IS POLKIT'S (2026-10-19). The service asks polkit itself (`pkcheck`), about the session helper's
// process, so polkit's own agent in that session shows the dialog and checks the person's password; a process of the
// user can neither answer it nor forge the answer, which comes back to the service and not through the helper. Locked,
// a yes lets the service open the vault with its own key (service-key.ts); a vault moved in from before, which has no
// such wrap yet, asks for its recovery key once and keeps the service's wrap from then on. Where polkit cannot ask (no
// agent in the session, pkcheck missing, an older polkit refusing the service's question), the recovery key is asked
// through the helper instead.

// pkcheck's exit statuses (pkcheck(1)).
const AUTHORIZED = 0;
const NOT_AUTHORIZED = 1;
const DISMISSED = 3;

export type PolkitAnswer = "yes" | "no" | "cannot-ask";

/** What a pkcheck exit says. Pure. */
export const polkitAnswerOf = (exitCode: number | null, missing: boolean): PolkitAnswer => {
    if (missing || exitCode === null) {
        return "cannot-ask";
    }
    if (exitCode === AUTHORIZED) {
        return "yes";
    }
    return exitCode === NOT_AUTHORIZED || exitCode === DISMISSED ? "no" : "cannot-ask";
};

// A process as polkit names it without a race: pid, its start time (/proc/<pid>/stat, field 22) and its uid.
export interface PolkitSubject {
    readonly pid: number;
    readonly start: string;
    readonly uid: string;
}

/** Field 22 of /proc/<pid>/stat, read past the command name, which may hold spaces and parentheses. Pure. */
export const startTimeOf = (stat: string): string | undefined => {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name, field 3 is first: field 22 is the 20th.
    const start = fields[19];
    return start !== undefined && /^\d+$/u.test(start) ? start : undefined;
};

/** The real uid on the `Uid:` line of /proc/<pid>/status. Pure. */
export const uidOf = (status: string): string | undefined => /^Uid:\s+(?<uid>\d+)/mu.exec(status)?.groups?.["uid"];

/** The helper's process, when `pid` is a live process of `uid`. */
export const subjectOf = async (pid: number, uid: string): Promise<PolkitSubject | undefined> => {
    try {
        const [stat, status] = await Promise.all([readFile(`/proc/${String(pid)}/stat`, "utf8"), readFile(`/proc/${String(pid)}/status`, "utf8")]);
        const start = startTimeOf(stat);
        return start !== undefined && uidOf(status) === uid ? { pid, start, uid } : undefined;
    } catch {
        // allow(silent-catch): a pid that is gone, or was never there, is no subject, which refuses the proof
        return undefined;
    }
};

// One line each, and short: polkit shows them in its dialog, and pkcheck reads them from argv (they name entries and
// sandboxes, never a value).
const detail = (text: string): string => text.replace(/\s+/gu, " ").slice(0, 300);

export const pkcheckArgs = (subject: PolkitSubject, notice: { readonly title: string; readonly message: string }): readonly string[] => [
    "--action-id",
    POLKIT_ACTION,
    "--process",
    `${String(subject.pid)},${subject.start},${subject.uid}`,
    "--allow-user-interaction",
    "--detail",
    "title",
    detail(notice.title),
    "--detail",
    "message",
    detail(notice.message),
];

// A person may take a while to come back to the computer; no longer than a grant lives.
const POLKIT_TIMEOUT_MS = 125_000;

export const askPolkit = async (runner: Runner, subject: PolkitSubject, notice: { readonly title: string; readonly message: string }): Promise<PolkitAnswer> => {
    const ran = await runner({ command: "pkcheck", args: pkcheckArgs(subject, notice), timeoutMs: POLKIT_TIMEOUT_MS });
    return ran.timedOut ? "no" : polkitAnswerOf(ran.exitCode, ran.missing);
};

export interface PolkitConsentDeps {
    readonly runner: Runner;
    // The proven helper's process, while one is connected.
    readonly helper: () => PolkitSubject | undefined;
    readonly serviceKey: ServiceKey;
    // The recovery key through the helper (passphraseConsent over remotePassphrasePrompt).
    readonly recovery: Consent;
}

const DECLINED: ConsentAnswer = { ok: false, code: "declined", reason: "The person at the computer said no." };

const nobody = (request: ConsentRequest): ConsentAnswer =>
    request.unlock
        ? { ok: false, code: "locked", reason: "The keyring is locked and nobody is signed in to ask: Passwords' session helper starts at sign-in." }
        : { ok: false, code: "declined", reason: "Nobody could be asked: Passwords' session helper starts at sign-in." };

export const polkitConsent = (deps: PolkitConsentDeps): Consent => {
    const recover = async (request: ConsentRequest): Promise<ConsentAnswer> => {
        const answer = await deps.recovery.ask(request);
        if (answer.ok && answer.vaultKey !== undefined) {
            await deps.serviceKey.adopt(answer.vaultKey);
        }
        return answer;
    };
    return {
        hello: undefined,
        askValue: deps.recovery.askValue,
        choose: deps.recovery.choose,
        ask: async (request) => {
            if (request.opener === undefined) {
                return await deps.recovery.ask(request);
            }
            const subject = deps.helper();
            if (subject === undefined) {
                return nobody(request);
            }
            const said = await askPolkit(deps.runner, subject, request);
            if (said === "no") {
                return DECLINED;
            }
            if (said === "cannot-ask") {
                return await recover(request);
            }
            if (!request.unlock) {
                return { ok: true, vaultKey: undefined, how: "verified" };
            }
            const vaultKey = await deps.serviceKey.open();
            // A vault from before the service, or one whose key file was lost: its recovery key, once.
            return vaultKey === undefined ? await recover(request) : { ok: true, vaultKey, how: "verified" };
        },
    };
};
