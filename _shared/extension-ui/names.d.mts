export declare const extensionUiNames: readonly string[];

export interface ExtensionUiDeprecation {
    readonly name: string;
    readonly use: string;
    readonly deprecated: string;
    readonly removableIn: string;
}

export declare const extensionUiDeprecated: readonly ExtensionUiDeprecation[];
