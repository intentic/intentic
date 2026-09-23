import type { PersonaKit, SkillDraft } from "@intentic/sandbox-contract";
import { useMutation } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { rpcQuery } from "../client/rpcQuery";
import { sandboxRpc } from "../client/sandboxRpc";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { useSandboxQuery } from "../client/useSandboxQuery";

// A persona's kit: prompt and skills at `.intentic/config/personas/<id>/`, fetched only for the open persona (unlike
// usePersonas, which lists personas). The daemon's `personas` push refreshes every kit along with the list; the id is
// reactive (accordion) and never absent (missing personas 404).

export function usePersonaKit(personaId: MaybeRefOrGetter<string>) {
    const id = computed(() => toValue(personaId));

    const { query, error } = useSandboxQuery(rpcQuery(`personas.kit`, () => ({ id: id.value })));

    // Invalidates only this persona's kit; nothing else changes.
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: rpcKey(`personas.kit`, { id: id.value }) });

    // Passed explicitly so `useMutation` doesn't need Vue's injection context to find the client.
    const savePrompt = useMutation(
        { mutationFn: (prompt: string) => sandboxRpc.personas.savePrompt({ id: id.value, prompt }), onSuccess: invalidate },
        queryClient,
    );
    const saveSkill = useMutation(
        { mutationFn: (skill: SkillDraft) => sandboxRpc.personas.saveSkill({ id: id.value, ...skill }), onSuccess: invalidate },
        queryClient,
    );
    const removeSkill = useMutation(
        { mutationFn: (name: string) => sandboxRpc.personas.removeSkill({ id: id.value, name }), onSuccess: invalidate },
        queryClient,
    );

    return {
        kit: computed<PersonaKit>(() => query.data.value ?? { prompt: ``, skills: [] }),
        // Fetches one skill's body on demand; the list view must not pay for every skill's content up front.
        readSkill: (name: string) => sandboxRpc.personas.readSkill({ id: id.value, name }),
        error,
        isLoading: query.isLoading,
        savePrompt,
        saveSkill,
        removeSkill,
    };
}
