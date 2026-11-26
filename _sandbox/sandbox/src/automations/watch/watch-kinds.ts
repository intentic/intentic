import { extensionIdOf, type WatchKindContribution, watchParamsProblem } from "@intentic/extension-manifest";
import { isUrlSource, type WatchKind, type WatchSource } from "@intentic/sandbox-contract/schemas/automations";
import { installedExtensions, type ExtensionHost, type InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import { sourceProblem } from "./watch-sources.js";

// (2026-11-26) THE WATCH KINDS EXTENSIONS DECLARE (`contributes.watchKinds`), read off the installed extensions as the
// catalogue's listener sources are: the composer, the `automations` command and an automation's approval card draw a
// kind from its declaration, saving checks a source's parameters against its fields, and a check reaches the extension's
// backend through the host's door (contributed-check.ts). One declaration per id, the first installed wins; `url` is the
// daemon's own and no extension declares it (the manifest refuses the id).

// One kind with what the daemon needs beside what the catalogue serves: the extension's routing id (its backend's door)
// and the cards whose gateway addresses its check is handed.
export interface DeclaredKind {
    readonly kind: WatchKind;
    readonly installId: string;
    readonly capabilities: readonly string[];
}

const servedOf = (extension: InstalledExtension, declared: WatchKindContribution): DeclaredKind => {
    const { capabilities, ...kind } = declared;
    return { kind: { ...kind, extension: extensionIdOf(extension.manifest), enabled: extension.enabled }, installId: extension.id, capabilities: capabilities ?? [] };
};

/** Every installed extension's watch kinds, on or off: one whose extension is off stays listed, so a stored source still reads. */
export const declaredKindsOf = (installed: readonly InstalledExtension[]): readonly DeclaredKind[] => {
    const kinds = new Map<string, DeclaredKind>();
    for (const extension of installed) {
        for (const declared of extension.manifest.contributes?.watchKinds ?? []) {
            // An enabled declaration wins over a switched-off one of the same id, whichever is installed first.
            const earlier = kinds.get(declared.id);
            if (earlier === undefined || (!earlier.kind.enabled && extension.enabled)) {
                kinds.set(declared.id, servedOf(extension, declared));
            }
        }
    }
    return [...kinds.values()];
};

export const declaredWatchKinds = async (host: ExtensionHost): Promise<readonly DeclaredKind[]> => declaredKindsOf(await installedExtensions(host));

/** The catalogue's list: the declarations as the composer and the command read them. */
export const catalogWatchKinds = async (host: ExtensionHost): Promise<WatchKind[]> => (await declaredWatchKinds(host)).map((declared) => declared.kind);

// Why no check can run for a contributed kind now: nothing declares it, or what declares it is off.
export const unservedWhy = (kind: string, declared: DeclaredKind | undefined): string | undefined => {
    if (declared === undefined) {
        return `no installed extension serves the "${kind}" watch kind: install the extension that declares it, or check something else`;
    }
    return declared.kind.enabled
        ? undefined
        : `${declared.kind.extension}, which serves the "${kind}" watch kind, is switched off: switch it back on in Extensions, or check something else`;
};

/**
 * Why a source could never be checked as written, or undefined when it can: a page that is not http(s) or a pattern that
 * does not compile; a kind no enabled extension declares; parameters its declaration does not take. What saving and a
 * check tried by hand refuse.
 */
export const watchSourceProblem = async (host: ExtensionHost, source: WatchSource): Promise<string | undefined> =>
    sourceProblemAmong(await declaredWatchKinds(host), source);

/** The same, among kinds already read. */
export const sourceProblemAmong = (kinds: readonly DeclaredKind[], source: WatchSource): string | undefined => {
    if (isUrlSource(source)) {
        return sourceProblem(source);
    }
    const declared = kinds.find((each) => each.kind.id === source.kind);
    return unservedWhy(source.kind, declared) ?? (declared === undefined ? undefined : watchParamsProblem(declared.kind, source));
};
