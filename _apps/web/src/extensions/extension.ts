import type { CapabilitySummary, PanelSummary } from "@intentic-app/api-contract";
import type { IconName } from "@intentic-app/ui";
import type { Component } from "vue";

/* First-party extensions: compiled-in, lazily-loaded UI modules that DETECT workspace content and contribute
 * their own sidebar elements. An extension runs `detect()` over the daemon-computed repo facts (one `/panels`
 * round-trip — the browser never scans /work file-by-file) AND the capability manifest, and returns an
 * activation per sidebar element it wants: Infrastructure contributes one, the apps extension one per
 * monorepo, agent-activity one when a monitored provider capability is connected. Evidence over identity — a
 * repo is served because of what it CONTAINS (deploy.config.ts, pnpm-workspace.yaml + turbo.json,
 * .intentic/ui), not what it happens to be named. The registry (index.ts) is a static array, deliberately NOT
 * a runtime plugin system: adding an extension is a reviewed product change shipped with the app. Extensions
 * consume the blessed app surface only (sandboxClient/composables, @intentic-app/ui + PrimeVue, TerminalView)
 * and talk to the daemon's typed routes — never to a process of their own. */

// One sidebar element an extension contributes: routed at /ext/<extension.id>/<key>, rendered by the
// extension's view with `repo` (+ props) bound.
export interface Activation {
    // Stable per-extension key (usually the repo name) — the route segment, so deep links survive reloads.
    readonly key: string;
    readonly title: string;
    // An IconName; absent ⇒ the rail renders the title's initials (repo-named elements).
    readonly icon?: IconName;
    // The repo this element is rooted at — the fallback-dedup subject and the view's `repo` prop. Absent for
    // capability-driven elements (agent-activity), which aren't rooted at any repo.
    readonly repo?: string;
    readonly props?: Record<string, unknown>;
}

export interface Extension {
    readonly id: string;
    // The capability's human name (e.g. "Apps", "UI", "Infrastructure") — distinct from an Activation's
    // per-repo `title`. Used to label the DirectoryOperator's surface switch when a repo activates several.
    readonly label: string;
    // Where this extension's activations live: `rail` = a global/capability-first left-rail tile routed at
    // /ext/:ext/:key (Infrastructure, Live status, Logs, Agent activity); `directory` = an identity-bound
    // per-repo panel opened by selecting its `repositories/<name>` directory in the Workspace tree (Apps, UI,
    // preview). One home per panel — the rail no longer scrolls a tile per repo.
    readonly surface: "rail" | "directory";
    // Evidence-based detection: repo-content extensions read `repos`, capability-driven ones read
    // `capabilities` — one activation per sidebar element either way.
    readonly detect: (repos: readonly PanelSummary[], capabilities: readonly CapabilitySummary[]) => Activation[];
    // A fallback extension's activations are dropped for repos already claimed by a non-fallback one — the
    // preview extension: the raw dev-server iframe only surfaces when no first-party UI serves the repo.
    readonly fallback?: true;
    // Lazily imported root view — one code-split chunk per extension; rendered with `repo` (+ props) bound.
    readonly view: () => Promise<Component>;
}
