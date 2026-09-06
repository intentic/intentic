import type { z } from "zod";

/* A CONTRIBUTION POINT, DEFINED ONCE, its key, its shape, and the sentence that explains it to the person
 * writing the manifest, in one object.
 *
 * The three used to live apart, and only two of them lived anywhere at all. The key and the shape sat in one
 * file that every feature had to edit to add anything, in two places (the schema, then the key on `contributes`);
 * the explanation sat in a `//` comment above it, where the extension author, the only reader it was written
 * for, could never see it. So the manifest was a thing you wrote by copying another extension's and guessing,
 * with a misspelt contribution point dropped in silence rather than named.
 *
 * Binding the description to the schema is what changes that: it rides `z.describe`, so it reaches the generated
 * authoring schema (json-schema.ts) and comes back as hover text in the author's editor. The prose that is for
 * MAINTAINERS, why a point exists, what it replaced, what it deliberately does not do, stays a comment in the
 * point's own file, because it is not what someone filling in a field needs to read. */
export interface ContributionPoint<Name extends string = string, Schema extends z.ZodType = z.ZodType> {
    // The key under `contributes` in intentic-extension.json.
    readonly name: Name;
    /* Written for the author, in the second person, and kept to what they must decide: what declaring this gets
     * them, and what the host does with it. It lands verbatim in editor hover text, so a paragraph of rationale
     * here is a paragraph in a tooltip. */
    readonly description: string;
    // The value shape under that key, an array for a point that takes many entries, the entry itself for a
    // point that takes one. `contributes` makes every one of them optional; a point is never required.
    readonly schema: Schema;
}
