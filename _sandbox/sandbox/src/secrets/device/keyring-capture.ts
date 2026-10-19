import { seal } from "@intentic/sandbox-contract/keyring-seal";
import type { KeyringCaptureOutcome, KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { opt } from "../../opt.js";
import type { KeyringComputer, KeyringLink } from "./keyring-link.js";

// A credential the person typed into a prompt in one of this sandbox's terminals, sent to be remembered by the keyring
// of the owner's computer that was used last, sealed there and then to its inbox key, so the sandbox carries it once and
// keeps nothing. Sent only where that keyring has remembering from sandboxes on: the person's own switch, not ours.

export interface SandboxCapture {
    readonly origin: KeyringOrigin;
    readonly value: string;
    readonly title?: string | undefined;
    readonly username?: string | undefined;
}

export type SandboxCaptureResult =
    | { readonly ok: true; readonly machine: string; readonly outcome: KeyringCaptureOutcome; readonly title?: string | undefined; readonly name?: string | undefined }
    | { readonly ok: false; readonly reason: string };

// How the sandbox names itself to a keyring's title line ("saved from intentic-dev"): its address's first label.
const viaOf = (sandboxUrl: string): string => {
    try {
        return new URL(sandboxUrl).hostname.split(".")[0] ?? sandboxUrl;
    } catch {
        // allow(silent-catch): an address that does not parse is still a name a person recognises
        return sandboxUrl.slice(0, 200);
    }
};

// The computer a sandbox capture goes to: the most recently active one whose keyring can take it.
export const captureTarget = (computers: readonly KeyringComputer[]): KeyringComputer | undefined =>
    computers.find((computer) => computer.online && computer.setUp && computer.inbox !== undefined && computer.remember?.sandbox === true);

export const sendSandboxCapture = async (link: Pick<KeyringLink, "computers" | "passwords" | "sandboxUrl">, capture: SandboxCapture, now: () => number = Date.now): Promise<SandboxCaptureResult> => {
    const target = captureTarget(await link.computers());
    if (target?.inbox === undefined) {
        return { ok: false, reason: "no computer of the owner's remembers passwords from sandboxes right now" };
    }
    const via = viaOf(await link.sandboxUrl());
    const at = now();
    const answer = await link.passwords.capture(target.machine, {
        origin: capture.origin,
        ...opt("username", capture.username),
        sealed: seal(target.inbox, capture.value, { kind: "capture", via, at }),
        source: "terminal",
        via,
        kind: "password",
        ...opt("title", capture.title),
        at,
    });
    return answer.ok ? { ok: true, machine: target.machine, outcome: answer.outcome, ...opt("title", answer.title), ...opt("name", answer.name) } : { ok: false, reason: answer.refusal };
};
