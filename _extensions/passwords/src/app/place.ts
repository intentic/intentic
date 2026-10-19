import type { KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { originOfUrl } from "./import/formats.js";

// A PLACE TYPED BY HAND into the editor's "Works on": `github.com`, `https://gitlab.example.com/login`, `FortiClient.exe`,
// `ssh radar@build-01`, `git https://github.com`, `sudo`, `sudo as root`. Undefined for something that is none of them,
// so the editor can say so rather than save a rule that never matches.
export const parsePlace = (typed: string): KeyringOrigin | undefined => {
    const text = typed.trim();
    if (text === ``) {
        return undefined;
    }
    const ssh = /^ssh\s+(\S+)$/iu.exec(text);
    if (ssh !== null) {
        return { kind: `ssh`, target: ssh[1] ?? `` };
    }
    const sudo = /^sudo(?:\s+(?:as\s+)?(\S+))?$/iu.exec(text);
    if (sudo !== null) {
        return sudo[1] === undefined ? { kind: `sudo` } : { kind: `sudo`, user: sudo[1] };
    }
    const git = /^git\s+(\S+)$/iu.exec(text);
    if (git !== null) {
        const url = git[1] ?? ``;
        return { kind: `git`, url: /^[a-z]+:\/\//iu.test(url) ? url : `https://${url}` };
    }
    // A program by its file name or path: `.exe`, a folder separator, or one word with no dot in it (`FortiClient`).
    if (/\.exe$/iu.test(text) || /[\\]/u.test(text) || (text.startsWith(`/`) && !text.includes(`.`)) || /^[\w-]+$/u.test(text)) {
        return { kind: `program`, program: text };
    }
    return /\s/u.test(text) ? undefined : originOfUrl(text);
};
