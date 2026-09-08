import { neutralizeOutsideText } from "@intentic/base/outside-text";

// Contract every format handler meets: markdown body (no front matter) plus a note for every cap or degradation hit,
// since a truncated document reading as complete is a lie.
// `version` is the staleness lever, stamped into sidecar front matter; a stamp mismatch re-derives on the next touch.
// Bump it whenever the output's shape changes, including a bug fix that changes what the markdown says.

export interface DerivedDoc {
    /** Empty means nothing to say, and still gets a sidecar so freshness has somewhere to live. */
    readonly markdown: string;
    /** Human title when the format carries one (metadata, first heading); the capsule leads with it. */
    readonly title?: string | undefined;
    /** Degradations and caps, one line each; printed in the capsule and stored in sidecar front matter. */
    readonly notes: string[];
}

export interface Deriver {
    readonly name: string;
    readonly version: number;
    readonly derive: (absPath: string) => Promise<DerivedDoc>;
}

/** `name v<version>`, the exact string stamped into and compared against sidecar front matter. */
export const deriverStamp = (deriver: Deriver): string => `${deriver.name} v${deriver.version}`;

// Any field can carry forged text (a pdf's Title as easily as its body), so the whole doc is neutralized at the
// pipeline boundary before it reaches stdout or disk.
// The sidecar writer neutralizes again independently; the fold is idempotent, so the second pass costs nothing.
export const neutralizeDoc = (doc: DerivedDoc): DerivedDoc => ({
    markdown: neutralizeOutsideText(doc.markdown),
    title: doc.title === undefined ? undefined : neutralizeOutsideText(doc.title),
    notes: doc.notes.map((note) => neutralizeOutsideText(note)),
});
