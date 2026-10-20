/*
 * EVERYTHING A FAILURE SAID, LAID OUT TO READ: what the details press of a failure notice opens (NoticeFailureDetails.vue)
 * under the line failureView gives it (agent-status/failureView.ts). The provider's prose with its links live, and the
 * facts it carried (the category, the request and message ids, a help article) pulled out of it.
 */

// What the Claude CLI appends under its message, each on a line of its own (or run together on a CLI that flattens them).
const FACTS = [
    { key: `category`, pattern: /\bDetails:\s*`?\[([^\]`\s]+)\]`?/ },
    { key: `request`, pattern: /\bRequest ID:\s*([\w-]+)/ },
    { key: `message`, pattern: /\bMessage ID:\s*([\w-]+)/ },
] as const;
const LEARN_MORE = /\bLearn more:\s*(https?:\/\/\S+)/;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

export type FailureFactKey = (typeof FACTS)[number][`key`];

export interface FailureFact {
    readonly key: FailureFactKey;
    readonly value: string;
}

/** One run of the details' prose: words, or a link the provider gave. */
export type FailureRun = { readonly text: string } | { readonly url: string; readonly label: string };

export interface FailureDetails {
    /** Everything said but the facts below, its paragraphs kept, its links live. */
    readonly prose: readonly FailureRun[];
    /** The category, request id and message id, in that order, each only where the provider gave it. */
    readonly facts: readonly FailureFact[];
    /** The help article the provider pointed to ("Learn more: …"). */
    readonly learnMore?: string;
}

// A link's words: its address without the scheme, the `www.` or a closing slash.
const linkLabel = (url: string): string => url.replace(/^https?:\/\/(?:www\.)?/, ``).replace(/\/$/, ``);

// The prose as runs, its links live; a full stop or a bracket closing the sentence is not part of the address.
const runs = (prose: string): FailureRun[] => {
    const out: FailureRun[] = [];
    let from = 0;
    for (const match of prose.matchAll(URL_PATTERN)) {
        const url = match[0].replace(/[.,;:!?)\]]+$/, ``);
        const start = match.index;
        if (start > from) {
            out.push({ text: prose.slice(from, start) });
        }
        out.push({ url, label: linkLabel(url) });
        from = start + url.length;
    }
    if (from < prose.length) {
        out.push({ text: prose.slice(from) });
    }
    return out;
};

/** Everything a failure said, laid out to read: its prose with live links, and the facts it carried pulled out. */
export const failureDetails = (said: string): FailureDetails => {
    let prose = said.trim();
    const facts: FailureFact[] = [];
    for (const { key, pattern } of FACTS) {
        const found = pattern.exec(prose);
        if (found !== null) {
            facts.push({ key, value: key === `category` ? found[1]!.replace(/_/g, ` `) : found[1]! });
            prose = prose.replace(found[0], ``);
        }
    }
    const learnMore = LEARN_MORE.exec(prose);
    if (learnMore !== null) {
        prose = prose.replace(learnMore[0], ``);
    }
    // What taking the facts out left: trailing spaces, doubled spaces, and blank lines where they stood.
    const tidy = prose
        .split(`\n`)
        .map((line) => line.replace(/ {2,}/g, ` `).trimEnd())
        .join(`\n`)
        .replace(/\n{3,}/g, `\n\n`)
        .trim();
    const details = { prose: runs(tidy), facts };
    return learnMore === null ? details : { ...details, learnMore: learnMore[1]!.replace(/[.,;:!?)\]]+$/, ``) };
};
