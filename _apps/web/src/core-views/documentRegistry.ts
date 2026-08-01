import type { Disposable, DocumentOffer } from "@intentic/extension-api";
import type { Component } from "vue";
import { shallowRef } from "vue";

/* Runtime registry of per-directory documents contributed by extensions (contributes.documents). The host merges
 * each api.documents.register call with its manifest declaration and stores it here; the Workspace tree asks
 * `documentsAt(path)` what a directory row should offer, and the editor area opens the answer as a tab. A
 * module-level singleton (the app's no-Pinia convention), the same shape as the view and viewer registries.
 *
 * Why the tree asks per path instead of being handed a set: a provider's answer is a LOOKUP into state the
 * extension keeps (see DocumentProviderRegistration.detect), and the tree is the only thing that knows which rows
 * are on screen — a monorepo's listing is lazily loaded, so nobody can enumerate the paths up front. */

export interface RegisteredDocumentProvider {
    // The owning extension's id — error attribution + manifest-gating key off this.
    readonly owner: string;
    readonly id: string;
    // The family's human name from the approved manifest ("Architecture") — what the tab strip's tooltip says
    // this document IS, beside the provider's own per-row title.
    readonly label: string;
    readonly detect: (path: string) => DocumentOffer | undefined;
    readonly component: () => Promise<Component>;
}

const providers = shallowRef<readonly RegisteredDocumentProvider[]>([]);

// Keyed by owner + provider id, exactly like the view and viewer registries: re-registering the same identity is
// a re-activation, so it replaces its predecessor in place rather than leaving two providers offering the same
// document on every row.
export const registerDocumentProvider = (provider: RegisteredDocumentProvider): Disposable => {
    const index = providers.value.findIndex((existing) => existing.owner === provider.owner && existing.id === provider.id);
    providers.value = index === -1 ? [...providers.value, provider] : providers.value.with(index, provider);
    return {
        dispose: (): void => {
            providers.value = providers.value.filter((entry) => entry !== provider);
        },
    };
};

// One provider's offer for a directory. A throwing detect() costs that provider its row and nothing else — the
// same containment the rail's detect() and badge() have, for the same reason: one broken extension must not blank
// the file tree.
export interface DocumentAt {
    readonly provider: RegisteredDocumentProvider;
    readonly offer: DocumentOffer;
}

// What the given directory (root-relative; "" is the workspace root) has to read, across every provider. Reads
// the registry ref, so a caller inside a computed re-runs when an extension registers, disposes — or when the
// provider's own state changes, since detect() is called here rather than cached.
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

// The provider a stored tab names, or undefined when nothing offers it any more (the extension was switched off
// or uninstalled between page loads) — the tab then says so rather than rendering an empty frame.
export const documentProvider = (owner: string, id: string): RegisteredDocumentProvider | undefined =>
    providers.value.find((provider) => provider.owner === owner && provider.id === id);

// The tab's identity: the provider that owns the document plus the directory it explains. Two providers may
// offer a document for the same directory, and both may be open at once.
export const documentTabId = (owner: string, id: string, path: string): string => `document:${owner}:${id}:${path}`;
