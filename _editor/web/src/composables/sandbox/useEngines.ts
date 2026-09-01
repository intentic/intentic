import { EnginesViewSchema } from "@intentic-app/api-contract";
import { computed } from "vue";
import { sandboxJson } from "./sandboxClient";
import { ENGINES } from "../queryKeys";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE AGENT ENGINES this sandbox runs — the Claude Code CLI and its SDK, codex, the Cursor SDK, opencode, the
 * subscription translator — and which version of each is on.
 *
 * Read from the daemon's /engines route. Every row carries where its version came from (the image, or the
 * store on the daemon's volume), what its channel would move it to, and what going back would mean, because
 * "which Claude Code is this sandbox on" stopped being a property of the image the day these became
 * installable at runtime. */

export const ENGINES_KEY = ENGINES.of();

export function useEngines() {
    const { query } = useSandboxQuery({
        queryKey: ENGINES_KEY,
        queryFn: async () => EnginesViewSchema.parse(await sandboxJson(`/engines`)),
    });
    const view = computed(() => query.data.value);
    const engines = computed(() => view.value?.engines ?? []);

    // A boolean rather than the ref, for the reason useEnvironment spells out: reaching through vue-query's
    // object in a template does not unwrap, so a refresh icon bound to it spins forever.
    const isFetching = computed(() => query.isFetching.value);

    // Rows with something waiting. What the card's badge counts, and the reason it is derived here rather than
    // in the template: the shell's own banner asks the same question.
    const updatable = computed(() => engines.value.filter((engine) => engine.offered !== undefined));

    return { view, engines, updatable, query, isFetching };
}
