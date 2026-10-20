export interface KitFinding {
    /** `path:line` relative to the extension's root, or `intentic-extension.json`. */
    readonly at: string;
    readonly why: string;
}

/** One version's record in extension-api's surface.json, the two grains a bundle links by name. */
export interface RecordedLinks {
    readonly uiKitExports?: readonly string[];
    readonly moduleExports?: readonly string[];
}

/** What an extension's sources must change for the kit and API it builds against (check/extension.mjs). */
export declare const extensionFindings: (input: {
    readonly files: readonly { readonly path: string; readonly text: string }[];
    readonly manifest: { readonly engines?: { readonly intentic?: string } } | undefined;
    readonly surface: Readonly<Record<string, RecordedLinks>> | undefined;
}) => KitFinding[];
