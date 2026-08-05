import type { DesiredStateGraph } from "@intentic/graph";
import { compile, toNodeMap } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { emit } from "./emit/emit.js";
import type { Catalog } from "./lib/catalog.js";
import { catalogFor } from "./lib/catalog.js";

// The state resolver: intent → needs → desired state. It derives the needs, assigns each the catalog option
// that fills its capability, and compiles the emitted nodes into one desired-state graph. The catalog is
// selected from the intent: i.have.github → GitHub stack; i.have.gitlab → GitLab stack; otherwise Forgejo+Komodo.
// `zone` is the Cloudflare zone the apps are exposed under: the CLI discovers it from the API token before
// resolving; pure callers (tests, fixtures) pass it directly. It is required whenever the intent has apps/services.
export const resolveState = (intent: IntentSet, zone?: string, catalog: Catalog = catalogFor(intent)): DesiredStateGraph => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        const options = catalog.optionsFor(need.capability);
        if (options.length === 0) {
            throw new Error(`no option satisfies "${need.capability}"`);
        }
        if (options.length > 1) {
            throw new Error(`ambiguous: "${need.capability}" has ${options.length} options but the state resolver makes no choice`);
        }
        byNeed.set(needKey(need), (options[0] as { id: string }).id);
    }
    const graph = compile(toNodeMap(emit(intent, { byNeed }, zone)));
    // Carry the authored renames onto the artifact so apply can reconcile them in place before reconciling.
    return intent.moved !== undefined && intent.moved.length > 0 ? { ...graph, moved: intent.moved } : graph;
};
