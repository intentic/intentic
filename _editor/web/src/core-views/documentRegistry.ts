import type { Disposable, DocumentOffer } from "@intentic/extension-api";
import type { Component } from "vue";
import { shallowRef } from "vue";

// Registry of per-directory documents from extensions (contributes.documents); the Workspace tree calls
// `documentsAt(path)` per row, the editor opens the result as a tab. Looked up per path, not handed as a set:
// a provider's answer depends on its own state, and paths can't be enumerated up front.

export interface RegisteredDocumentProvider {
    // The owning extension's id; error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly id: string;
    // The family's human name from the manifest ('Architecture'); shown in the tab strip's tooltip.
    readonly label: string;
    readonly detect: (path: string) => DocumentOffer | undefined;
    readonly component: () => Promise<Component>;
}

const providers = shallowRef<readonly RegisteredDocumentProvider[]>([]);

// Keyed by owner + provider id, like the view and viewer registries: re-registering the same identity
// replaces its predecessor in place rather than leaving two providers offering the same document.
export const registerDocumentProvider = (provider: RegisteredDocumentProvider): Disposable => {
    const index = providers.value.findIndex((existing) => existing.owner === provider.owner && existing.id === provider.id);
    providers.value = index === -1 ? [...providers.value, provider] : providers.value.with(index, provider);
    return {
        dispose: (): void => {
            providers.value = providers.value.filter((entry) => entry !== provider);
        },
    };
};

// One provider's offer for a directory. A throwing detect() costs that provider its row and nothing else,
// same containment as the rail's detect() and badge(): one broken extension must not blank the file tree.
export interface DocumentAt {
    readonly provider: RegisteredDocumentProvider;
    readonly offer: DocumentOffer;
}

// What the given directory (root-relative; "" is the workspace root) has to read, across every provider.
// detect() runs here rather than cached, so a caller inside a computed re-runs on register/dispose or provider state
// changes.
export const documentsAt = (path: string): readonly DocumentAt[] =>
    providers.value.flatMap((provider) => {
        try {
            const offer = provider.detect(path);
            return offer === undefined ? [] : [{ provider, offer }];
        } catch (error) {
            console.error(`extension ${provider.owner}: document provider "${provider.id}" detect() failed`, error);
            return [];
        }
    });

// The provider a stored tab names, or undefined if nothing offers it any more (switched off or uninstalled
// between page loads); the tab then says so rather than rendering empty.
export const documentProvider = (owner: string, id: string): RegisteredDocumentProvider | undefined =>
    providers.value.find((provider) => provider.owner === owner && provider.id === id);

// The tab's identity: the provider that owns the document plus the directory it explains. Two providers may
// offer a document for the same directory, and both may be open at once.
export const documentTabId = (owner: string, id: string, path: string): string => `document:${owner}:${id}:${path}`;
