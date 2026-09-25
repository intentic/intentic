import type { z } from "zod";
import type { Conversion, Granularity } from "./conversions.js";

// Every stored document the daemon reads back, declared once beside the store that owns it: its path, the shape this
// build writes, the conversions that bring any earlier shape to it, and where it lived before. The store runs the
// conversions on every read; the boot step (state-convergence.ts) writes converted files back and moves documents
// that changed address; the pre-flight (state-plan.ts) plans the same work read-only; the shape generator freezes each
// schema so a later change that would strand an old file fails the typecheck until a conversion covers it.

// Which volume a document's path is relative to: the workspace (/work), the history volume, or the AI-auth root
// (`.intentic/secrets/auth/` unless AGENT_AUTH_DIR moved it).
export type DocumentRoot = "workspace" | "history" | "auth";

export interface DocumentSpec<Schema extends z.ZodType = z.ZodType, History extends readonly Conversion[] = readonly Conversion[]> {
    readonly root: DocumentRoot;
    // Root-relative with forward slashes, no trailing slash.
    readonly path: string;
    // A directory of one file per entry (jsonDir), each file one document of this shape.
    readonly directory: boolean;
    // False for an interchange format (a sandbox.toml, a bundle manifest) its own parser converts on the way in: the boot
    // step never looks for it on disk, and the shape generator still freezes it.
    readonly boot: boolean;
    // The shape this build writes: the whole file for granularity "object", one entry for "entries" and "record", one
    // file for a directory.
    readonly schema: Schema;
    readonly granularity: Granularity;
    // Append-only: a conversion is never edited or removed once shipped, only followed by another.
    readonly history: History;
    // Earlier addresses, oldest first, relative to the same root. The boot step copies the newest one present into
    // place when the current path is absent, and deletes it once the grace window has passed.
    readonly movedFrom: readonly string[];
    // The oldest release whose files this build still converts ("v1.232.0"): shapes frozen before it stay on record
    // but are not checked, and the document's reader refuses such a file with a message saying what to do instead. A
    // deliberate support horizon, not a way around a missing conversion.
    readonly horizon: string | undefined;
}

export interface DocumentDefinition<Schema extends z.ZodType, History extends readonly Conversion[]> {
    readonly root?: DocumentRoot;
    readonly path: string;
    readonly directory?: boolean;
    readonly boot?: boolean;
    readonly schema: Schema;
    readonly granularity?: Granularity;
    readonly history?: History;
    readonly movedFrom?: readonly string[];
    readonly horizon?: string;
}

// Keyed by root and path; a module evaluated twice (a test's fresh import) replaces its own entry.
const registry = new Map<string, DocumentSpec>();

export const documentKey = (spec: Pick<DocumentSpec, "root" | "path">): string => `${spec.root}:${spec.path}`;

// `const` type parameters keep the history a tuple of its literal conversions, which is what lets the generated shape
// checks replay it at the type level.
export const defineDocument = <const Schema extends z.ZodType, const History extends readonly Conversion[] = readonly []>(
    definition: DocumentDefinition<Schema, History>,
): DocumentSpec<Schema, History> => {
    const spec: DocumentSpec<Schema, History> = {
        root: definition.root ?? "workspace",
        path: definition.path.replace(/\/$/, ""),
        directory: definition.directory ?? false,
        boot: definition.boot ?? true,
        schema: definition.schema,
        granularity: definition.granularity ?? "object",
        history: definition.history ?? ([] as readonly Conversion[] as History),
        movedFrom: definition.movedFrom ?? [],
        horizon: definition.horizon,
    };
    if (spec.movedFrom.includes(spec.path)) {
        throw new Error(`document ${documentKey(spec)} lists its own path among its earlier ones`);
    }
    registry.set(documentKey(spec), spec);
    return spec;
};

// Every document defined by a module this process has loaded, in definition order.
export const registeredDocuments = (): readonly DocumentSpec[] => [...registry.values()];

// A number that only grows as conversions ship: every conversion and earlier address any document declares. The state
// manifest records the highest one that ran here, which is how a rolled-back build knows a newer one converted files.
export const engineEpoch = (documents: readonly DocumentSpec[] = registeredDocuments(), steps = 0): number =>
    documents.reduce((sum, spec) => sum + spec.history.length + spec.movedFrom.length, steps);
