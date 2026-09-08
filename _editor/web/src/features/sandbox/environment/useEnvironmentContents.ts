import { EnvironmentContentsSchema, type EnvironmentItem } from "@intentic/api-contract";
import { computed, ref } from "vue";
import { SandboxHttpError, sandboxJson } from "../client/sandboxClient";
import { ENVIRONMENT_CONTENTS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";

// This sandbox's contents, grouped by whose decision put it there. A separate, on-demand query from useEnvironment,
// since probing every tool's version costs process spawns. `unsupported` reads a 404 as an older daemon lacking this
// hand-written route (not gated through supportsRoute), not a fault.

const ENVIRONMENT_CONTENTS_KEY = ENVIRONMENT_CONTENTS.of();

// Read order: agent-approved custom additions, then capability cost, then the unchosen base — narrowest decision first.
const GROUPS = [
    { origin: `custom`, label: `Added for this workspace` },
    { origin: `capability`, label: `From your capabilities` },
    { origin: `base`, label: `Comes with every sandbox` },
] as const satisfies readonly { origin: EnvironmentItem[`origin`]; label: string }[];

export interface ContentsGroup {
    readonly origin: EnvironmentItem[`origin`];
    readonly label: string;
    readonly items: EnvironmentItem[];
}

export function useEnvironmentContents(enabled: () => boolean) {
    // Bumped by refresh() to force a re-probe; a mid-session install stays cached as missing otherwise.
    const reprobe = ref(0);
    const { query, error } = useSandboxQuery({
        queryKey: ENVIRONMENT_CONTENTS_KEY,
        queryFn: async () => EnvironmentContentsSchema.parse(await sandboxJson(`/environment/contents${reprobe.value > 0 ? `?refresh` : ``}`)),
        enabled: computed(enabled),
        // A 4xx is a verdict, not a hiccup: no extra retries; anything else still gets one.
        retry: (attempts, failure) => !(failure instanceof SandboxHttpError && failure.status >= 400 && failure.status < 500) && attempts < 1,
    });

    // Sticky for the query's life, so a later reachability blip can't reoffer a tab already found missing.
    const unsupported = computed(() => query.error.value instanceof SandboxHttpError && query.error.value.status === 404);

    const items = computed(() => query.data.value?.items ?? []);
    // Kept distinct from 'the answer is empty': probing takes a moment, and reading that gap as empty would flash a
    // full sandbox as stock.
    const loading = computed(() => query.isPending.value || (query.isFetching.value && items.value.length === 0));
    const groups = computed((): ContentsGroup[] =>
        GROUPS.map((group) => ({
            origin: group.origin,
            label: group.label,
            items: items.value.filter((item) => item.origin === group.origin),
        })).filter((group) => group.items.length > 0),
    );
    // What the owner still has to decide on, so the toggle can say so before they open it.
    const awaiting = computed(() => items.value.filter((item) => item.state === `awaiting-approval`).length);

    const refresh = (): void => {
        reprobe.value += 1;
        void query.refetch();
    };

    return { groups, awaiting, loading, error, unsupported, refresh };
}
