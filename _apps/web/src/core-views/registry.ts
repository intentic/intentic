import type { Activation, CapabilityFacts, Disposable, RepoFacts, ViewRegistration } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { coreViews } from "./coreViews";

/* The runtime extension registry: core views seed it at module load; dynamically loaded third-party bundles join
 * through api.views.register. A module-level singleton ref (the app's no-Pinia convention), so every host —
 * rail, mobile menu, ExtensionHost, DirectoryOperator — recomputes off the same reactive list. */

interface RegisteredView {
    // "builtin" or the owning extension's id — error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly registration: ViewRegistration;
}

const views = shallowRef<readonly RegisteredView[]>(coreViews.map((registration) => ({ owner: `builtin`, registration })));

// A registration is IDENTIFIED by owner + view id, not by object identity: the same extension registering the
// same view id again can only mean it is being re-activated (the dev server hot-reloading the host module while
// this registry — a leaf dependency — keeps its instance, a re-run after install), never a second view. So a
// re-registration REPLACES its predecessor in place rather than appending; otherwise every re-activation grows
// the rail another copy of the same icon. In place, so tile order stays put while it happens.
export const registerView = (owner: string, registration: ViewRegistration): Disposable => {
    const entry: RegisteredView = { owner, registration };
    const index = views.value.findIndex((existing) => existing.owner === owner && existing.registration.id === registration.id);
    views.value = index === -1 ? [...views.value, entry] : views.value.with(index, entry);
    return {
        // Filtered by THIS entry, so a stale disposable held by a superseded activation can't evict the live
        // replacement — it just finds nothing to remove.
        dispose: (): void => {
            views.value = views.value.filter((existing) => existing !== entry);
        },
    };
};

// One resolved sidebar element: the view registration + the activation it contributed.
export interface ActiveExtension {
    readonly extension: ViewRegistration;
    readonly activation: Activation;
}

// The deep-link path to a sidebar element. The `:key` segment only disambiguates a view's multiple activations
// (one per repo: /ext/preview/<repo>); a singleton view names its sole activation after itself (key === id), so
// that segment would just repeat the view id — drop it. `/ext/ports`, not `/ext/ports/ports`. ExtensionHost
// resolves the missing segment back to the view id.
export const extensionPath = (extension: ViewRegistration, activation: Activation): string =>
    activation.key === extension.id ? `/ext/${extension.id}` : `/ext/${extension.id}/${encodeURIComponent(activation.key)}`;

// detect() failures are contained, not propagated: one broken extension contributes nothing this round instead
// of blanking every sidebar element with it.
const safeDetect = (entry: RegisteredView, repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]): Activation[] => {
    try {
        return entry.registration.detect(repos, capabilities);
    } catch (error) {
        console.error(`extension ${entry.owner}/${entry.registration.id}: detect() failed`, error);
        return [];
    }
};

// Run every registered view's detect() and compose the sidebar: fallback activations are dropped for repos a
// claiming view already serves — the single cross-extension rule, applied once here. Neither a `fallback` view
// nor an `auxiliary` one claims: the first because it IS the thing being replaced, the second because it sits
// beside the repo's main surface rather than subsuming it (see ViewRegistration.auxiliary). Repo-less
// (capability-driven) activations sit outside the claim rule. Reads the registry ref, so callers inside a
// computed re-run when an extension registers or disposes.
export const detectActivations = (repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]): ActiveExtension[] => {
    const detected = views.value.map((entry) => ({ extension: entry.registration, activations: safeDetect(entry, repos, capabilities) }));
    const claimed = new Set(
        detected
            .filter(({ extension }) => extension.fallback !== true && extension.auxiliary !== true)
            .flatMap(({ activations }) => activations.flatMap((a) => (a.repo === undefined ? [] : [a.repo]))),
    );
    return detected.flatMap(({ extension, activations }) =>
        (extension.fallback === true ? activations.filter((a) => a.repo === undefined || !claimed.has(a.repo)) : activations).map((activation) => ({
            extension,
            activation,
        })),
    );
};
