export interface KitFinding {
    /** `path:line` relative to the extension's root, or `intentic-extension.json`. */
    readonly at: string;
    readonly why: string;
}

/** One version's record in extension-api's surface.json: the two grains a bundle links by name, and the wire it may read. */
export interface RecordedLinks {
    readonly uiKitExports?: readonly string[];
    readonly moduleExports?: readonly string[];
    /** Per @intentic/sandbox-contract specifier an extension may import, from 2.44.0. */
    readonly wireExports?: Readonly<Record<string, { readonly exports: readonly string[]; readonly schemas: string }>>;
}

/** The sandbox-contract specifiers the newest record that has `wireExports` allows, or undefined when none has. */
export declare const wireOf: (surface: Readonly<Record<string, RecordedLinks>> | undefined) => ReadonlySet<string> | undefined;

/** What an extension's sources must change for the kit and API it builds against (check/extension.mjs). */
export declare const extensionFindings: (input: {
    readonly files: readonly { readonly path: string; readonly text: string }[];
    readonly manifest: { readonly engines?: { readonly intentic?: string } } | undefined;
    readonly surface: Readonly<Record<string, RecordedLinks>> | undefined;
}) => KitFinding[];
