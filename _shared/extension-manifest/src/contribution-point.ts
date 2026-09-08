import type { z } from "zod";

// A contribution point's key, shape and author-facing description in one object. The description rides `z.describe`, so
// it reaches the generated authoring schema and shows as editor hover text; maintainer-facing rationale stays a comment
// in the point's own file.
export interface ContributionPoint<Name extends string = string, Schema extends z.ZodType = z.ZodType> {
    // The key under `contributes` in intentic-extension.json.
    readonly name: Name;
    // Second person, kept to what the author must decide; lands verbatim as editor hover text.
    readonly description: string;
    // The value shape under that key: an array for a point taking many entries, the entry itself for one taking a
    // single entry. `contributes` makes every point optional.
    readonly schema: Schema;
}
