import type { SecretInventoryEntry } from "@intentic/sandbox-contract/schemas/secrets";
import { timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// The facts an open secret states about itself, in the words a reader asks them in: when it was last spent and on what,
// and where it lives. Pure, so the sentences are pinned without drawing a row.

/** A fact as its row draws it: the answer, the code it names (a command, a window), and what it means under it. */
export interface SecretFactWords {
    readonly said: string;
    /** A command's or script's start, a window's title: drawn as code, cut to a line, whole on hover. */
    readonly code?: string | undefined;
    readonly note?: string | undefined;
}

/** A phrase made to open a value: "7 hours ago", "asks each time" are said mid-sentence elsewhere, and lead here. */
export const capitalized = (phrase: string): string => `${phrase.charAt(0).toLocaleUpperCase()}${phrase.slice(1)}`;

type LastUse = NonNullable<SecretInventoryEntry[`lastUse`]>;

/** What it was spent on, and the code that names it when there is some. */
interface LaneWords {
    readonly phrase: string;
    readonly code?: string | undefined;
}

// What it was spent on, by the lane the ledger recorded. A command's and a script's start are code, said under the
// sentence rather than inside it; a site, a computer and a request's host read as words.
const laneWords = (use: LastUse): LaneWords => {
    const detail = use.detail;
    switch (use.lane) {
        case `shell`:
            return { phrase: t(`capabilities.secretFacts.inCommand`), code: detail };
        case `code`:
            return { phrase: t(`capabilities.secretFacts.inScript`), code: detail };
        case `desktop`:
            return { phrase: t(`capabilities.secretFacts.typedOnDesktop`), code: detail };
        case `browser`:
        case `device`:
            return { phrase: detail === undefined ? t(`capabilities.secretFacts.typed`) : t(`capabilities.secretFacts.typedOn`, { detail }) };
        case `gateway`:
            return { phrase: detail === undefined ? t(`capabilities.secretFacts.viaGateway`) : t(`capabilities.secretFacts.viaGatewayTo`, { detail }) };
        case `ssh`:
            return { phrase: detail === undefined ? t(`capabilities.secretFacts.viaSshAgent`) : t(`capabilities.secretFacts.viaSshAgentFor`, { detail }) };
    }
};

/** When the agent last spent it, on what, and who released it if somebody had to. */
export const lastUseWords = (use: LastUse, now: number = Date.now()): SecretFactWords => {
    const { phrase, code } = laneWords(use);
    return {
        said: capitalized(`${timeAgo(use.at, { now, days: true })} · ${phrase}`),
        code,
        note: use.approvedBy === undefined ? undefined : t(`capabilities.secretFacts.releasedBy`, { who: use.approvedBy }),
    };
};

// A path is read character by character; "the capability vault" is read as words.
const PATH_LIKE = /^[^\s]*\/[^\s]*$/u;

/** Where it lives, and that the sandbox made it when it did. */
export const storedWords = (entry: Pick<SecretInventoryEntry, `storedAt` | `kind`>): SecretFactWords & { readonly path: boolean } => ({
    said: entry.storedAt,
    path: PATH_LIKE.test(entry.storedAt),
    note: entry.kind === `generated` ? t(`capabilities.secretFacts.generatedForYou`) : undefined,
});
