import { scrubReason } from "../installTelemetry";

/* THE WHOLE STOP, AS AN EVENT MAY CARRY IT (2026-11-21). A failure's `reason` is its headline, and a headline alone
   says nothing: "1 thing is in the way:", "found 1 problem — fix them and re-run the same command:", "ic was downloaded
   but not installed, and no copy is installed." all reached the funnel with the thing itself cut off. ic's stop block
   (its ui.rs `explain`, prepare's and checks.rs' numbered lists) and the scripts' Stop-Intentic print a `problem:` and
   a `fix:` under the headline, one pair per numbered item in a list; they are read here into properties of their own,
   scrubbed like the reason, and the few failures worth counting by kind are given a code. */

/** One item of a stop block: its numbered title where the block is a list, and what it says went wrong and to do. */
interface StopItem {
    title?: string;
    problem?: string;
    fix?: string;
}

// A list's item (`  1. WSL`), and the two labelled lines under a headline or an item.
const ITEM = /^\d+\.\s+(.+)$/;
const LABELLED = /^(problem|fix):\s*(.*)$/;

/** The items of a stop block, in order: a block that is no list is one item. Lines that are neither are skipped. Pure. */
export const stopItems = (block: string): StopItem[] => {
    const items: StopItem[] = [];
    let current: StopItem | undefined;
    for (const raw of block.split(/\r?\n/)) {
        const line = raw.trim();
        const item = ITEM.exec(line);
        if (item !== null) {
            current = { title: item[1]?.trim() };
            items.push(current);
            continue;
        }
        const labelled = LABELLED.exec(line);
        const label = labelled?.[1] === `problem` || labelled?.[1] === `fix` ? labelled[1] : undefined;
        if (label === undefined) {
            continue;
        }
        if (current === undefined || current[label] !== undefined) {
            current = {};
            items.push(current);
        }
        current[label] = labelled?.[2]?.trim() ?? ``;
    }
    return items.filter((item) => item.problem !== undefined || item.fix !== undefined);
};

// Any path left once the home folder is `~`: a drive path, a share, `~\…`, or an absolute Unix path of two parts or more
// (a URL's own slashes, `npipe:////./pipe/…` and `ghcr.io/intentic/sandbox` are not: each is preceded by a word, a dot,
// a colon or a slash).
const PATHS = /\b[A-Za-z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|\\]+\\[^\s"'<>|]*|~[\\/][^\s"'<>|]*|(?<![\w.~:/\\-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g;

// A Windows profile folder the text names itself, up to the separator after it. Its name may have a space in it (the
// reader of 2026-10-12 was "prf game"), where scrubReason's own guess stops and would send the rest of the name.
const PROFILE = /\b[A-Za-z]:[\\/]Users[\\/][^\\/"'<>|:*?\r\n]+(?=[\\/])/i;

/**
 * Words a run said, fit to send: the account's home folder and name, any email address, the setup code and then any
 * path at all taken out (installTelemetry.ts `scrubReason`, with the home given, else read off the text itself), on one
 * line and at most 300 characters.
 */
export const scrubDetail = (text: string, hide: { readonly home?: string; readonly code?: string } = {}): string =>
    scrubReason(text, { home: hide.home ?? PROFILE.exec(text)?.[0], code: hide.code }).replace(PATHS, `<path>`);

/** A failure counted by kind: Windows' sockets out of buffers under WSL, and WSL unable to look up the account it runs as. */
export type FailureCause = `winsock-buffers` | `wsl-user-lookup`;

/** What an event carries of a failure beyond its reason; each key only where the failure said it. */
export interface FailureDetail {
    /** What went wrong, scrubbed: `1. <title>: <problem> | 2. …` for a list, the bare problem otherwise. */
    readonly problem?: string;
    /** What to do about it, scrubbed, in the same order. */
    readonly fix?: string;
    /** How many things a list said were in the way; absent for a block that is no list. */
    readonly problemCount?: number;
    /** Security software removed or refused one of Intentic's programs (the scripts' Get-IntenticSecurityAdvice). */
    readonly blockedBy?: `security-software`;
    /** The product Windows' Security Center named, when the script read one: a product's name, not a person's. */
    readonly securityProduct?: string;
    readonly cause?: FailureCause;
}

// The scripts' sentence for a refused program (scripts-kit's Get-IntenticSecurityAdvice `Suspect`), naming the product
// where Security Center names one, and the machine agent's own (agent_install.rs).
const SECURITY = /Security software (?:on this PC(?: \(([^)\r\n]{1,80})\))? may be blocking|is blocking)/i;
// WSAENOBUFS (Winsock out of buffers, a VPN's or a network filter's driver), as WSL reports a start it could not make.
const WINSOCK_BUFFERS = /0x80072747/i;
// WSL unable to read the distro's account database (`CreateProcessParseCommon:…: getpwnam(root) failed 5`).
const USER_LOOKUP = /getpwnam\([^)]*\) failed/i;

const causeOf = (text: string): FailureCause | undefined => {
    if (WINSOCK_BUFFERS.test(text)) {
        return `winsock-buffers`;
    }
    return USER_LOOKUP.test(text) ? `wsl-user-lookup` : undefined;
};

const joined = (parts: readonly string[], hide: { readonly home?: string; readonly code?: string }): string | undefined => {
    const said = scrubDetail(parts.filter((part) => part !== ``).join(` | `), hide);
    return said === `` ? undefined : said;
};

/** Mutable while it is filled in, so a key is set only where the failure said it. */
type Filling = { -readonly [Key in keyof FailureDetail]: FailureDetail[Key] };

/**
 * A failure's detail from everything it said (a stop block, or any text when there is none): its problem and fix lines,
 * scrubbed, how many items a list had, security software where a line names it, and its cause where it is one counted.
 * Pure.
 */
export const failureDetail = (said: string | undefined, hide: { readonly home?: string; readonly code?: string } = {}): FailureDetail => {
    const detail: Filling = {};
    if (said === undefined || said.trim() === ``) {
        return detail;
    }
    const items = stopItems(said);
    const list = items.some((item) => item.title !== undefined);
    // `1. <title>: <text>` for a list's item, the bare text for a block that is no list.
    const line = (index: number, title: string | undefined, text: string | undefined): string =>
        [list ? `${index + 1}.` : ``, title === undefined ? `` : `${title}:`, text ?? ``].filter((part) => part !== ``).join(` `);
    const problem = joined(items.map((item, index) => (item.problem === undefined && item.title === undefined ? `` : line(index, item.title, item.problem))), hide);
    const fix = joined(items.map((item, index) => (item.fix === undefined ? `` : line(index, undefined, item.fix))), hide);
    if (problem !== undefined) {
        detail.problem = problem;
    }
    if (fix !== undefined) {
        detail.fix = fix;
    }
    if (list) {
        detail.problemCount = items.length;
    }
    const security = SECURITY.exec(said);
    if (security !== null) {
        detail.blockedBy = `security-software`;
        const product = security[1]?.trim();
        if (product !== undefined && product !== ``) {
            detail.securityProduct = product;
        }
    }
    const cause = causeOf(said);
    if (cause !== undefined) {
        detail.cause = cause;
    }
    return detail;
};

/** A failure as an event carries it: its reason (installTelemetry.ts `scrubReason`) and its detail. */
export interface FailureFacts extends FailureDetail {
    readonly reason?: string;
}

/**
 * A failed run's facts from what it said: `row`, the requirement row that failed, else `line`, its last error line, is
 * its reason; its stop block (`block`), the row, and security software's requirement (`blocked`) are read for its
 * detail. Pure.
 */
export const failureFacts = (
    said: { readonly line?: string; readonly block?: string; readonly row?: string; readonly blocked?: string },
    hide: { readonly home?: string; readonly code?: string },
): FailureFacts => {
    const detail = failureDetail([said.block, said.row, said.blocked].filter((text) => text !== undefined).join(`\n`), hide);
    const headline = said.row ?? said.line;
    const reason = headline === undefined ? `` : scrubReason(headline, hide);
    return reason === `` ? detail : { reason, ...detail };
};
