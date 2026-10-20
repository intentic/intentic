import { createHash } from "node:crypto";
import { AUTH_STATE_FILES } from "@intentic/sandbox-contract/state/auth-state";
import { type Portability, type StateFile, stateFileFor } from "@intentic/sandbox-contract/state/state-portability";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract/state/workspace-state";
import type { z } from "zod";
import type { Conversion, Granularity } from "./conversions.js";

// Every stored document the daemon reads back, declared once beside the store that owns it: its path, the shape this
// build writes, the conversions that bring any earlier shape to it, and where it lived before. The store runs the
// conversions on every read; the boot step (state-convergence.ts) writes converted files back and moves documents
// that changed address; the pre-flight (state-plan.ts) plans the same work read-only; the shape generator freezes each
// schema so a later change that would strand an old file fails the typecheck until a conversion covers it. Defining one
// registers nothing: the boot step and the pre-flight read every document from state-registry.ts, which the shape
// generator writes from the source, so neither depends on which modules a process happened to load.

// Which volume a document's path is relative to: the workspace (/work), the history volume, or the AI-auth root
// (`.intentic/secrets/auth/` unless AGENT_AUTH_DIR moved it).
export type DocumentRoot = "workspace" | "history" | "auth";

export interface DocumentSpec<
    Schema extends z.ZodType = z.ZodType,
    History extends readonly Conversion[] = readonly Conversion[],
    MovedByStep extends readonly string[] = readonly string[],
    Layout extends Granularity = Granularity,
    Directory extends boolean = boolean,
> {
    readonly root: DocumentRoot;
    // Root-relative with forward slashes, no trailing slash.
    readonly path: string;
    // A directory of one file per entry (jsonDir), each file one document of this shape.
    readonly directory: Directory;
    // False for an interchange format (a sandbox.toml, a bundle manifest) its own parser converts on the way in: the boot
    // step never looks for it on disk, and the shape generator still freezes it.
    readonly boot: boolean;
    // The shape this build writes: the whole file for granularity "object", one entry for "entries" and "record", one
    // file for a directory.
    readonly schema: Schema;
    readonly granularity: Layout;
    // Append-only: a conversion is never edited or removed once shipped, only followed by another.
    readonly history: History;
    // Earlier addresses, oldest first, relative to the same root. The boot step copies the newest one present into
    // place when the current path is absent, and deletes it once the grace window has passed.
    readonly movedFrom: readonly string[];
    // The oldest release whose files this build still converts ("v1.232.0"): shapes frozen before it stay on record
    // but are not checked, and the document's reader refuses such a file with a message saying what to do instead. A
    // deliberate support horizon, not a way around a missing conversion.
    readonly horizon: string | undefined;
    // Keys a structural step moves out of this document into another home (a webhook token into the door store), as
    // dotted paths (`trigger.token`). Not a conversion, since a reader that ran it without the step (a guest) would lose
    // the value; declared so the shape check (conversion-types.ts, VanishedKeys) knows the key left on purpose.
    readonly movedByStep: MovedByStep;
    // Whether it travels in a bundle, and for a workspace file which views it invalidates. A history document says so on
    // its own definition (Placement below), and the bundle's table is generated from those (history-state.ts beside this); a
    // workspace or auth one is found by its path in the contract's tables (WORKSPACE_STATE_FILES, AUTH_STATE_FILES).
    // Undefined for a workspace or auth path no entry claims, which the registry's test refuses.
    readonly stateFile: StateFile | undefined;
}

// Where a document lives, and for one on the history volume whether it travels in a bundle and what the bundle report
// tells the owner when it does not. Required there by the type, and read off the source as literals by the index
// generator (state-modules.ts), which refuses a history document that does not say: a hand-kept list of them beside the
// documents broke whenever one was added without its line (CI attempts 12 and 19, 2026-10).
type Placement =
    | { readonly root?: "workspace" | "auth"; readonly portability?: never; readonly note?: never }
    | { readonly root: "history"; readonly portability: Portability; readonly note?: string };

export type DocumentDefinition<
    Schema extends z.ZodType,
    History extends readonly Conversion[],
    MovedByStep extends readonly string[] = readonly [],
    Layout extends Granularity = "object",
    Directory extends boolean = false,
> = Placement & {
    readonly path: string;
    readonly directory?: Directory;
    readonly boot?: boolean;
    readonly schema: Schema;
    readonly granularity?: Layout;
    readonly history?: History;
    readonly movedFrom?: readonly string[];
    readonly horizon?: string;
    readonly movedByStep?: MovedByStep;
};

// What a definition says of its own portability on the history volume, else the contract's entry for its path: the
// longest one that claims it.
const stateFileOf = (placement: Placement, path: string): StateFile | undefined => {
    if (placement.root === "history") {
        const declared = { path, portability: placement.portability };
        return placement.note === undefined ? declared : { ...declared, note: placement.note };
    }
    return stateFileFor(path, placement.root === "auth" ? AUTH_STATE_FILES : WORKSPACE_STATE_FILES);
};

export const documentKey = (spec: Pick<DocumentSpec, "root" | "path">): string => `${spec.root}:${spec.path}`;

// `const` type parameters keep the history a tuple of its literal conversions, which is what lets the generated shape
// checks replay it at the type level.
export const defineDocument = <
    const Schema extends z.ZodType,
    const History extends readonly Conversion[] = readonly [],
    const MovedByStep extends readonly string[] = readonly [],
    const Layout extends Granularity = "object",
    const Directory extends boolean = false,
>(
    definition: DocumentDefinition<Schema, History, MovedByStep, Layout, Directory>,
): DocumentSpec<Schema, History, MovedByStep, Layout, Directory> => {
    const root = definition.root ?? "workspace";
    const path = definition.path.replace(/\/$/, "");
    const spec: DocumentSpec<Schema, History, MovedByStep, Layout, Directory> = {
        root,
        path,
        // SAFETY: each default below is the one its type parameter defaults to when the definition leaves it out.
        directory: definition.directory ?? (false as Directory),
        boot: definition.boot ?? true,
        schema: definition.schema,
        granularity: definition.granularity ?? ("object" as Layout),
        history: definition.history ?? ([] as readonly Conversion[] as History),
        movedFrom: definition.movedFrom ?? [],
        horizon: definition.horizon,
        // SAFETY: an absent list is its type parameter's default, the empty tuple.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the empty tuple widens through readonly string[] to reach a type parameter
        movedByStep: definition.movedByStep ?? ([] as readonly string[] as MovedByStep),
        stateFile: stateFileOf(definition, definition.directory === true ? `${path}/` : path),
    };
    if (spec.movedFrom.includes(spec.path)) {
        throw new Error(`document ${documentKey(spec)} lists its own path among its earlier ones`);
    }
    return spec;
};

// A count of every conversion and earlier address the documents declare, plus the steps. Kept only because builds before
// the conversion digest read it: they stamp and compare it (newest-run.json, the journal's episodes), so this build still
// writes it, never lower than what the stamp holds. Nothing here decides anything by it.
export const engineEpoch = (documents: readonly DocumentSpec[], steps: readonly { readonly id: string }[]): number =>
    documents.reduce((sum, spec) => sum + spec.history.length + spec.movedFrom.length, steps.length);

// What identifies a conversion episode: every conversion (its description) and earlier address each document declares,
// under the document's key, and every step's id, in an order no import graph decides. Two builds with the same digest
// convert the same files the same way, so one resumes the other's interrupted episode; any other open episode is put
// back. A document with nothing to convert does not move it.
export const conversionDigest = (documents: readonly DocumentSpec[], steps: readonly { readonly id: string }[]): string => {
    const lines = [
        ...documents
            .filter((spec) => spec.history.length > 0 || spec.movedFrom.length > 0)
            .toSorted((a, b) => documentKey(a).localeCompare(documentKey(b)))
            .flatMap((spec) => [
                `document ${documentKey(spec)}`,
                ...spec.history.map((conversion) => `  converts: ${conversion.describe}`),
                ...spec.movedFrom.map((path) => `  moved from: ${path}`),
            ]),
        ...steps.map((step) => `step ${step.id}`).toSorted(),
    ];
    return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
};
