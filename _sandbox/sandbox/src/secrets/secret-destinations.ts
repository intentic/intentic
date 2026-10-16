import { normalizeHost } from "@intentic/sandbox-contract/policy/secret-hosts";
import { SECRET_REFERENCE } from "@intentic/sandbox-contract/schemas/needs";
import { FETCHER_READERS } from "./destinations/secret-command-fetchers.js";
import { gitReach } from "./destinations/secret-command-git.js";
import { urlHost, WEB_SCHEMES } from "./destinations/secret-command-hosts.js";
import { lex } from "./destinations/secret-command-lex.js";
import { UTILITY_READERS } from "./destinations/secret-command-utilities.js";
import { type ProgramReader, type Reach, STAND_IN, type Word } from "./destinations/secret-command-words.js";

// Where one use of a secret would send it, read from the reference-form text before anything runs, for the host limit
// (host-guard-gate.ts). Heuristic by nature, so it reads the other way round from a classifier: it proves nothing, and
// every doubt is an answer of its own. `certain` is only ever said when a line splits into stages the reader can account
// for one by one — a program whose destination sits in its arguments (curl, wget, git), a bare literal assignment, or a
// utility that opens no socket and runs nothing (jq, grep, head, cd, echo, …) — joined by the plain separators `|`, `&`,
// `;` and newline. A value reaches a host only through the stage that spells it, so a line every stage of which the
// reader can name sends nowhere it does not name: `certain` collects the hosts of every stage, and one unreadable stage
// (an interpreter, a subshell, a redirect, a run-time expansion in the wrong place) leaves the whole line unreadable.
// That is "every host the text names is these", never "this is safe"; the owner's list decides the rest. The machine is
// not read at all: a .curlrc, a git config or /etc/hosts can still point a named host elsewhere.
//
// destinations/ holds the parts: the shell lexer, the option grammar the program readers share, and one reader per kind
// of program (fetchers, git, utilities).

export type Destination =
    // Every host the use names; empty when every stage is read and none connects anywhere (a value that stays inside).
    | { readonly certain: true; readonly hosts: readonly string[] }
    // Why it cannot be read, as a clause that finishes "…because ": the card and the refusal both say it.
    | { readonly certain: false; readonly why: string };

const unreadable = (why: string): Destination => ({ certain: false, why });

const REFERENCE = new RegExp(SECRET_REFERENCE.source, "g");

// A Map, not an object: a program named `constructor` must find nothing, not Object's own.
const PROGRAMS: ReadonlyMap<string, ProgramReader> = new Map<string, ProgramReader>([...UTILITY_READERS, ...FETCHER_READERS, ["git", gitReach]]);

// Every URL written anywhere in the text, a header or a body included: a list is a claim about every host the command
// names, not only the one the program is pointed at. It ends where the shell would end a word (`;`, `|`, a redirect), so
// `R=https://host;` reads as `host`.
const URL_ANYWHERE = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`);|<>]*/gi;

// The program one stage runs and what its arguments reach, or why neither can be trusted.
const programReach = (words: readonly Word[]): Reach => {
    const [program, ...args] = words;
    if (program === undefined) {
        return { why: "it runs nothing" };
    }
    if (program.assignment === true) {
        if (words.some((word) => word.assignment === true && word.text.startsWith("PATH="))) {
            return { why: "it changes PATH, which can change which program runs" };
        }
        // A stage that is only `NAME=value` literals sets shell variables and runs nothing, so it sends nothing and
        // steers nothing (an unexported name reaches no later program's environment). One with a program after the
        // assignments puts them in that program's environment, which can change where it connects; a value filled in at
        // run time (`A="$B"`) is not a literal the reader can stand behind.
        return words.every((word) => word.assignment === true && !word.dynamic)
            ? { hosts: [] }
            : { why: "it sets environment variables for the program, which can change where it connects" };
    }
    const reach = program.dynamic ? undefined : PROGRAMS.get(program.text);
    if (reach === undefined) {
        const named = program.text.includes(STAND_IN) ? "a program named by the secret" : `\`${program.text}\``;
        return { why: `it runs ${named}, and where that sends things is not in the command's text` };
    }
    return reach(args);
};

// Where a shell command would send what it carries: every host it names when every stage is one the reader can account
// for, else why not. One unreadable stage answers for the whole line, since what it does with the value cannot be read.
export const commandDestination = (command: string): Destination => {
    const text = command.trim().replace(REFERENCE, STAND_IN);
    const lexed = lex(text);
    if ("why" in lexed) {
        return unreadable(lexed.why);
    }
    const hosts = new Set<string>();
    for (const segment of lexed.segments) {
        const reach = programReach(segment);
        if ("why" in reach) {
            return unreadable(reach.why);
        }
        for (const host of reach.hosts) {
            hosts.add(host);
        }
    }
    // URLs are read from the lexed words, not the raw text: continuations and escapes are already resolved there, and
    // comments are gone, so an address in a comment does not count and an escaped one reads as the shell would pass it.
    for (const word of lexed.segments.flat()) {
        for (const match of word.text.matchAll(URL_ANYWHERE)) {
            const host = urlHost(match[0]);
            if (host === undefined) {
                return unreadable(`the host in "${match[0]}" cannot be read`);
            }
            hosts.add(host);
        }
    }
    return { certain: true, hosts: [...hosts] };
};

// A script decides where it sends things as it runs; its text shows at most where it might.
export const SCRIPT_DESTINATION: Destination = unreadable("it is a script, and a script decides where it sends things as it runs");

// The page a value would be typed into: its host is the destination.
export const pageDestination = (url: string): Destination => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return unreadable("the page's address cannot be read");
    }
    const host = WEB_SCHEMES.has(parsed.protocol.slice(0, -1)) ? normalizeHost(parsed.hostname) : undefined;
    return host === undefined ? unreadable(`the page (${parsed.protocol}) has no host a list could name`) : { certain: true, hosts: [host] };
};
