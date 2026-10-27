import { t } from "@intentic/ui/i18n";
import type { AccessReason } from "./accessReason";

// EVERY SENTENCE THE EDITOR SAYS ABOUT WHAT A PERSON MAY NOT DO, built from the reason alone so the same "no" reads the
// same everywhere: who it is for in the app's own role words, what the person can still do, and what to do about it.
// Never the daemon's sentence ("maintainer access required"), which names a tier nobody chose a word for.
//
// The four shapes a surface needs:
// - `short`: a chip or a two-word tooltip on the one press that stays drawn ("Maintainers only").
// - `title`: the headline of a place the person cannot open, naming it ("Only maintainers can open Secrets").
// - `note`: the one line over a place they can read but not change ("You can look around. Only maintainers can…").
// - `line`: the way forward under either, depending on whether they have asked already or an organisation decides.

export interface AccessWords {
    readonly short: string;
    readonly title: string;
    readonly note: string;
    readonly line: string;
}

// The key each reason reads its words under: a tier by its name, the rest by what they are.
type ReasonKey = `owner` | `maintainer` | `writer` | `collaborator` | `agentsOff` | `guest` | `area` | `org`;

const keyOf = (reason: AccessReason): ReasonKey => {
    switch (reason.kind) {
        case `tier`:
            // A route floored at the viewer refuses only a guest, whose reason is its own; anything at or under it reads
            // as the next tier up, the one a grant would give.
            return reason.floor === `owner` || reason.floor === `maintainer` || reason.floor === `writer` ? reason.floor : `collaborator`;
        case `agents-off`:
            return `agentsOff`;
        case `guest`:
        case `area`:
        case `org`:
            return reason.kind;
    }
};

const shortOf = (key: ReasonKey, reason: AccessReason): string => {
    if (reason.kind === `org`) {
        return t(`common.access.short.org`, { org: reason.org });
    }
    return key === `guest` || key === `area` ? t(`common.access.short.notShared`) : t(`common.access.short.${key}`);
};

/**
 * The words for one refusal. `place` names what was refused as its page or section is titled ("Secrets"), for the
 * headline; `asked` says the person has asked the owner already, which changes the way forward.
 */
export const accessWords = (reason: AccessReason, options: { readonly place?: string; readonly asked?: boolean } = {}): AccessWords => {
    const key = keyOf(reason);
    const org = reason.kind === `org` ? reason.org : ``;
    const place = options.place ?? ``;
    return {
        short: shortOf(key, reason),
        title: t(`common.access.title.${key}`, { place, org }),
        note: t(`common.access.note.${key}`, { org }),
        line: reason.kind === `org` ? t(`common.access.line.org`) : options.asked === true ? t(`common.access.line.asked`) : t(`common.access.line.ask`),
    };
};
