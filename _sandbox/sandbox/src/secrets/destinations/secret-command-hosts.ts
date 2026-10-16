import { normalizeHost } from "@intentic/sandbox-contract/policy/secret-hosts";
import { type Reach, STAND_IN, type Unreadable, type Word } from "./secret-command-words.js";

export const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
export const WEB_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);

// The host a URL names, past the scheme and any userinfo (a token spelled before an `@` is not the host), before the port
// and the path. Undefined when it is not a plain host a list could name.
export const urlHost = (url: string): string | undefined => {
    const authority = url.replace(URL_SCHEME, "").split(/[/?#]/)[0] ?? "";
    // A backslash is a separator to some URL parsers and userinfo to others, so the host after it is anybody's guess.
    if (authority.includes("\\")) {
        return undefined;
    }
    return normalizeHost(authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, ""));
};

// One argument a program connects to, read as its host.
const urlDestination = (word: Word, schemes: ReadonlySet<string>): { readonly host: string } | Unreadable => {
    if (word.dynamic) {
        return { why: "where it connects is filled in from a variable when it runs" };
    }
    const scheme = URL_SCHEME.exec(word.text)?.[1]?.toLowerCase();
    if (scheme !== undefined && !schemes.has(scheme)) {
        return { why: `it uses a ${scheme}:// address, which this check does not read` };
    }
    const host = urlHost(word.text);
    if (host === undefined) {
        return {
            why: word.text.includes(STAND_IN) ? "the secret is part of the address it connects to" : `the host in "${word.text}" cannot be read`,
        };
    }
    return { host };
};

// The hosts of every argument a program connects to; a program pointed at none is not one this can read.
export const hostsOf = (words: readonly Word[], schemes: ReadonlySet<string>): Reach => {
    const hosts: string[] = [];
    for (const word of words) {
        const found = urlDestination(word, schemes);
        if ("why" in found) {
            return found;
        }
        hosts.push(found.host);
    }
    return hosts.length === 0 ? { why: "it names no host it would connect to" } : { hosts };
};
