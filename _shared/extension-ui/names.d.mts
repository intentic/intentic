export declare const extensionUiNames: readonly string[];

export interface ExtensionUiDeprecation {
    readonly name: string;
    readonly use: string;
    /** The extension API version an author first reads it as deprecated in. */
    readonly since: string;
    readonly deprecated: string;
    readonly removableIn: string;
}

export declare const extensionUiDeprecated: readonly ExtensionUiDeprecation[];

/** A prop (`Component.prop`) or recipe member (`ui.member`) a view may no longer use, though every name still links. */
export interface ExtensionUiRetirement {
    readonly name: string;
    readonly use: string;
    readonly since: string;
    readonly why: string;
}

export declare const extensionUiRetired: readonly ExtensionUiRetirement[];
