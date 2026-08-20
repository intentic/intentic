import { EnvironmentContentsSchema, type EnvironmentItem } from "@intentic-app/api-contract";
import { computed, ref } from "vue";
import { SandboxHttpError, sandboxJson } from "./sandboxClient";
import { ENVIRONMENT_CONTENTS } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE SANDBOX'S CONTENTS, what it has, grouped by whose decision put it there.
 *
 * A separate query from useEnvironment on purpose, and not merely for tidiness: this read asks every tool on the
 * overlay for its version, so it costs process spawns, while `environment` is polled by the shell's rebuild
 * banner and re-fetched on every write under the environment state files. Sharing one key would put that cost on
 * the whole app for the sake of one tab. It is `enabled` only while the contents view is actually on screen for
 * the same reason.
 *
 * AND IT FEATURE-DETECTS, because the browser is routinely newer than the daemon it talks to and that is a
 * supported state rather than a fault (see useDaemonRoutes): the app plane serves whatever image a user last
 * pulled, and in local development the web app runs from the working tree while the daemon is the last built
 * one. A daemon that predates this route answers 404, which the generic path renders as "Could not read what
 * the sandbox has installed · Request failed (404)", i.e. a broken feature, which is exactly the ambiguity that
 * machinery exists to kill. `unsupported` is what lets the card stop OFFERING the view instead, and fall back to
 * the recipe it has always been able to show. Not gated through `supportsRoute` because this is a hand-written
 * Hono route rather than a contract one, so the daemon never advertises it by name; the 404 is the only signal
 * there is, and it is a reliable one.
 */

const ENVIRONMENT_CONTENTS_KEY = ENVIRONMENT_CONTENTS.of();

// The order the groups are read in: what an agent asked for and the owner approved, then the price of the
// capabilities they turned on, then what nobody chose. Narrowest decision first, that is the one they revisit.
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
    // Bumped by refresh() to re-probe: a tool installed mid-session is cached as missing on the daemon until
    // something asks it to look again, and "I just installed that" needs an answer nearer than a restart.
    const reprobe = ref(0);
    const { query, error } = useSandboxQuery({
        queryKey: ENVIRONMENT_CONTENTS_KEY,
        queryFn: async () => EnvironmentContentsSchema.parse(await sandboxJson(`/environment/contents${reprobe.value > 0 ? `?refresh` : ``}`)),
        enabled: computed(enabled),
        // A refusal is a verdict, not a hiccup: three more attempts at a route the daemon does not have spend
        // three round-trips to learn what the first one said. Anything else still gets one retry.
        retry: (attempts, failure) => !(failure instanceof SandboxHttpError && failure.status >= 400 && failure.status < 500) && attempts < 1,
    });

    // The daemon is older than this view. Sticky for the query's life, so a later reachability blip cannot make
    // the card offer a tab it already found out is not there.
    const unsupported = computed(() => query.error.value instanceof SandboxHttpError && query.error.value.status === 404);

    const items = computed(() => query.data.value?.items ?? []);
    /* WHETHER THERE IS AN ANSWER YET, which the view needs kept apart from "the answer is nothing". Probing forty
     * commands takes a moment, and for that moment the item list is legitimately empty, a view that read it as
     * empty would tell somebody with a full sandbox that theirs is stock, then correct itself a second later. */
    const loading = computed(() => query.isPending.value || (query.isFetching.value && items.value.length === 0));
    const groups = computed((): ContentsGroup[] =>
        GROUPS.map((group) => ({
            origin: group.origin,
            label: group.label,
            items: items.value.filter((item) => item.origin === group.origin),
        })).filter((group) => group.items.length > 0),
    );
    // What the owner is being asked to decide on, so the toggle can say so before they open it.
    const awaiting = computed(() => items.value.filter((item) => item.state === `awaiting-approval`).length);

    const refresh = (): void => {
        reprobe.value += 1;
        void query.refetch();
    };

    return { groups, awaiting, loading, error, unsupported, refresh };
}
