import { seal } from "@intentic/sandbox-contract/keyring-seal";
import { gitOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import { keyringPaths } from "../address.js";
import { askKeyring, KeyringUnavailable } from "../client.js";
import type { KeyringRequest, KeyringResponse } from "../protocol.js";

// `intentic-keyring git-credential <get|store|erase>`: git's credential helper (`credential.helper`, registered by
// intentic-machine ahead of any other). git writes `key=value` lines on standard input and reads them back on standard
// output (gitcredentials(7)). `get` answers with the entry serving that https remote at the person's yes; `store`,
// which git sends after a sign-in worked, is a capture (source `git`) that also proves the value; `erase`, sent when one
// failed, takes back a capture not yet proved. Anything but https is left to git's other helpers, and so is a remote
// the keyring has nothing for: git then asks its next helper, or its prompt, which reaches the keyring's own box.

export type GitAction = "get" | "store" | "erase";

export interface GitCredential {
    readonly url: string;
    readonly username?: string | undefined;
    readonly password?: string | undefined;
}

/** git's `key=value` lines as a credential, or undefined for one that is not an https remote. Pure. */
export const parseGitCredential = (text: string): GitCredential | undefined => {
    const fields = new Map<string, string>();
    for (const line of text.split(/\r?\n/u)) {
        const equals = line.indexOf("=");
        if (equals > 0) {
            fields.set(line.slice(0, equals), line.slice(equals + 1));
        }
    }
    let url = fields.get("url");
    if (url === undefined) {
        const host = fields.get("host");
        url = host === undefined ? undefined : `${fields.get("protocol") ?? ""}://${host}`;
    }
    const parsed = url === undefined ? null : URL.parse(url);
    if (parsed === null || parsed.protocol !== "https:") {
        return undefined;
    }
    const username = fields.get("username") ?? (parsed.username === "" ? undefined : decodeURIComponent(parsed.username));
    return { url: gitOrigin(`https://${parsed.host}`), username, password: fields.get("password") };
};

/** What git reads back for `get`. Pure. */
export const gitCredentialAnswer = (username: string | undefined, password: string): string => `${username === undefined ? "" : `username=${username}\n`}password=${password}\n`;

export interface GitIo {
    readonly input: string;
    readonly write: (text: string) => void;
    readonly warn: (text: string) => void;
    readonly ask?: <R extends KeyringRequest>(request: R) => Promise<KeyringResponse<R["op"]>>;
    readonly now?: () => number;
}

const pipeAsk = async <R extends KeyringRequest>(request: R): Promise<KeyringResponse<R["op"]>> => await askKeyring({ address: keyringPaths().address }, request);

// Always exits 0: a helper that fails makes git print an error and carry on to the next one anyway, and the keyring's
// own reason goes to standard error for a person reading the terminal.
export const runGitCredential = async (action: GitAction, io: GitIo): Promise<number> => {
    const credential = parseGitCredential(io.input);
    const ask = io.ask ?? pipeAsk;
    if (credential === undefined) {
        return 0;
    }
    try {
        if (action === "store") {
            await store(credential, ask, io.now ?? Date.now);
            return 0;
        }
        const request: Extract<KeyringRequest, { op: "git-credential" }> = { op: "git-credential", action, url: credential.url };
        if (credential.username !== undefined) {
            request.username = credential.username;
        }
        const answer = await ask(request);
        if (!answer.ok) {
            io.warn(`intentic-keyring: ${answer.refusal}\n`);
        } else if (action === "get" && answer.value !== undefined) {
            io.write(gitCredentialAnswer(answer.username ?? credential.username, answer.value));
        }
    } catch (error) {
        io.warn(`intentic-keyring: ${error instanceof KeyringUnavailable ? error.message : "Passwords could not be asked"}\n`);
    }
    return 0;
};

const store = async (credential: GitCredential, ask: NonNullable<GitIo["ask"]>, now: () => number): Promise<void> => {
    if (credential.password === undefined || credential.password === "") {
        return;
    }
    const state = await ask({ op: "state" });
    const inbox = state.ok ? state.state.keys?.inbox : undefined;
    if (inbox === undefined) {
        return;
    }
    const at = now();
    const item = { origin: { kind: "git", url: credential.url }, sealed: seal(inbox, credential.password, { kind: "capture", via: "git", at }), source: "git", via: "git", kind: "password", at } as const;
    await ask({ op: "capture", item: credential.username === undefined ? item : { ...item, username: credential.username } });
};
