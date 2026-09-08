import { type PersonaKit, PersonaKitSchema, type SkillDraft } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { PERSONAS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { useSandboxQuery } from "../client/useSandboxQuery";

// A persona's kit: prompt and skills at `.intentic/config/personas/<id>/`, fetched only for the open card (unlike
// usePersonas, which lists cards). Keyed under the personas family so removing a card invalidates its kit too; the id
// is reactive (accordion) and never absent (missing personas 404).

const kitKey = (id: string): readonly unknown[] => PERSONAS.of(id, `kit`);

export function usePersonaKit(personaId: MaybeRefOrGetter<string>) {
    const id = computed(() => toValue(personaId));

    const { query, error } = useSandboxQuery({
        queryKey: computed(() => kitKey(id.value)),
        queryFn: async () => PersonaKitSchema.parse(await sandboxJson(`/personas/${encodeURIComponent(id.value)}/kit`)),
    });

    // Invalidates only this persona's kit; nothing else changes.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: kitKey(id.value) });
    const path = (tail: string): string => `/personas/${encodeURIComponent(id.value)}${tail}`;

    // Passed explicitly so `useMutation` doesn't need Vue's injection context to find the client.
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
        // Fetches one skill's body on demand; the list view must not pay for every skill's content up front.
        readSkill: (name: string) => sandboxJson(path(`/skills/read?name=${encodeURIComponent(name)}`)),
        error,
        isLoading: query.isLoading,
        savePrompt,
        saveSkill,
        removeSkill,
    };
}
