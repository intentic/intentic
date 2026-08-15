import { type PersonaKit, PersonaKitSchema, type SkillDraft } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";
import { PERSONAS } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { useSandboxQuery } from "./useSandboxQuery";

/* ONE PERSONA'S KIT — the prompt it runs on and the skills only its turns reach (`.intentic/personas/<id>/`).
 *
 * Separate from usePersonas, which reads the CARDS: a kit is files, it is only ever wanted for the one card
 * somebody has open, and reading every persona's prompt to draw a list of names would fetch text nothing on
 * screen shows. Keyed under the personas family so the two caches stay related — a card removed takes its kit
 * with it daemon-side, and invalidating the family after that is what stops a stale kit being drawn for a
 * persona that no longer exists.
 *
 * THE APP'S ONE CLIENT IS NAMED RATHER THAN INJECTED, for the reason useSandboxQuery spells out: `useQueryClient`
 * resolves through Vue's injection context, and this composable is mounted inside a form that a suite renders on
 * its own. There is exactly one QueryClient in this app, so naming it is the same object with no way for the
 * ceremony to fail.
 *
 * The id is reactive because this hangs off an accordion: opening a different card must refetch rather than keep
 * showing the last one's prompt. It is never absent — a persona is created before it is edited, and the routes
 * answer a missing card with a 404 deliberately, so that nothing can mint a kit for a persona nobody named. */

const kitKey = (id: string): readonly unknown[] => PERSONAS.of(id, `kit`);

export function usePersonaKit(personaId: MaybeRefOrGetter<string>) {
    const id = computed(() => toValue(personaId));

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => kitKey(id.value)),
        queryFn: async () => PersonaKitSchema.parse(await sandboxJson(`/personas/${encodeURIComponent(id.value)}/kit`)),
    });

    // Only this card's kit moves. A prompt or a skill changes no other persona and no capability, so a wider
    // invalidation would refetch caches to observe that they are identical.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: kitKey(id.value) });
    const path = (tail: string): string => `/personas/${encodeURIComponent(id.value)}${tail}`;

    // The same client, handed over rather than injected — see the header. `useMutation` resolves it through the
    // injection context too, so passing it is what lets this component be rendered outside a plugin-installed app.
    const savePrompt = useMutation(
        { mutationFn: (prompt: string) => sandboxJson(path(`/prompt`), jsonBody(`POST`, { id: id.value, prompt })), onSuccess: invalidate },
        queryClient,
    );
    const saveSkill = useMutation(
        { mutationFn: (skill: SkillDraft) => sandboxJson(path(`/skills`), jsonBody(`POST`, { id: id.value, ...skill })), onSuccess: invalidate },
        queryClient,
    );
    const removeSkill = useMutation(
        { mutationFn: (name: string) => sandboxJson(path(`/skills/remove`), jsonBody(`POST`, { id: id.value, name })), onSuccess: invalidate },
        queryClient,
    );

    return {
        kit: computed<PersonaKit>(() => query.data.value ?? { prompt: ``, skills: [] }),
        // The body of one skill, fetched only when somebody opens it — a group of one-line rows must not cost
        // the sum of its instructions to draw (the same split the sandbox's own skills list makes).
        readSkill: (name: string) => sandboxJson(path(`/skills/read?name=${encodeURIComponent(name)}`)),
        error,
        isLoading: query.isLoading,
        savePrompt,
        saveSkill,
        removeSkill,
    };
}
