import { neutralizeOutsideText } from "@intentic/base/outside-text";

/* The contract every format handler answers to. A deriver turns one file into markdown BODY (no front
 * matter — sidecar.ts owns that) plus honesty notes: every cap hit, every degradation (a PDF with no text
 * layer, a spreadsheet cut at the row cap) surfaces as a note rather than as silence, because a truncated
 * document that reads like a complete one is a lie with consequences (webq's rule, inherited whole).
 *
 * `version` is the staleness lever: it is stamped into every sidecar's front matter, and a sidecar whose
 * stamp disagrees with the current deriver re-derives on the next touch. Bump it whenever the OUTPUT changes
 * shape — a bug fix that changes what the markdown says is exactly the case the stamp exists for. */

export interface DerivedDoc {
    /** Markdown body. Empty means "nothing to say" and still gets a sidecar, so freshness has a place to live. */
    readonly markdown: string;
    /** A human title when the format carries one (document metadata, first heading); the capsule leads with it. */
    readonly title?: string | undefined;
    /** Degradations and caps, one line each, printed in the capsule and stored in the sidecar front matter. */
    readonly notes: string[];
}

export interface Deriver {
    readonly name: string;
    readonly version: number;
    readonly derive: (absPath: string) => Promise<DerivedDoc>;
}

/** `name v<version>`, the exact string stamped into and compared against sidecar front matter. */
export const deriverStamp = (deriver: Deriver): string => `${deriver.name} v${deriver.version}`;

/* Every field of a derivation carries the FILE's words — a pdf's Title metadata can spell a forged envelope
 * marker as easily as its body can — so the whole doc is neutralized at the pipeline boundary, before any of
 * it reaches stdout or disk. The sidecar writer neutralizes again on its own account (its invariant is "no
 * derived byte reaches disk unneutralized", and it must not depend on its callers); the fold is idempotent,
 * so the belt costs the braces nothing. */
export const neutralizeDoc = (doc: DerivedDoc): DerivedDoc => ({
    markdown: neutralizeOutsideText(doc.markdown),
    title: doc.title === undefined ? undefined : neutralizeOutsideText(doc.title),
    notes: doc.notes.map((note) => neutralizeOutsideText(note)),
});
