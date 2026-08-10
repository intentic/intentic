import { type SkillBody, SkillBodySchema, type SkillDraft, type SkillSummary, SkillsListSchema } from "@intentic-app/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";
import { sandboxKey } from "./useSandbox";
import { useSandboxQuery } from "./useSandboxQuery";
import { useSandboxSettings } from "./useSandboxSettings";

/* WHAT THE AGENT KNOWS, from the screen's side — the list, and the two writes that change the half of it the
 * owner authored.
 *
 * The list is a daemon read rather than anything derived from settings, and that is the point: skills arrive from
 * six directions (their own, this image's, every connection, every extension, every plugin, plus whatever is
 * simply sitting in the folder) and only the daemon can see all six at once. Each row arrives already carrying
 * what may be done to it, so no control here has to re-derive a rule the daemon owns.
 *
 * THE SWITCH IS A SETTINGS WRITE, not a route of its own. Which skills are on lives in the sandbox settings
 * object, so flipping one rides useSandboxSettings' single optimistic write — the switch moves under the finger
 * instead of after a round-trip, and the whole Agent tab already shares that cache. The daemon reconciles the
 * loaded folder on that save, which is what makes the next turn agree with the screen. Only the LIST needs
 * refetching afterwards, since a skill's row reads its enabled state from the daemon's join and not from the
 * settings object this patched. */

const QUERY_KEY = sandboxKey(`skills`);

export function useSkills() {
    const queryClient = useQueryClient();
    const { settings, patch } = useSandboxSettings();

    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<SkillSummary[]> => SkillsListSchema.parse(await sandboxJson(`/skills`)),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    // Upsert by name: saving over an existing skill rewrites it. A new one comes back switched on, which is why
    // this refetches rather than patching a row in place — the daemon decides that, not the form.
    const save = useMutation({
        mutationFn: (draft: SkillDraft) => sandboxJson(`/skills`, jsonBody(`POST`, draft)),
        onSuccess: invalidate,
    });

    const remove = useMutation({
        mutationFn: (name: string) => sandboxJson(`/skills/remove`, jsonBody(`POST`, { name })),
        onSuccess: invalidate,
    });

    const skills = computed<SkillSummary[]>(() => query.data.value ?? []);

    /* Turn one switchable skill on or off by editing the enabled list. Written from the SETTINGS list rather than
     * from the rows, because that array is the stored truth and the rows are a join over it — rebuilding it from
     * what is currently on screen would drop the name of any skill the daemon knows about and this list does not
     * (a baked tool added by a newer image, say). */
    const setEnabled = (name: string, enabled: boolean): void => {
        const current = settings.value?.skills;
        if (current === undefined) {
            return;
        }
        patch({ skills: enabled ? [...new Set([...current, name])] : current.filter((entry) => entry !== name) });
        void invalidate();
    };

    // One skill's text, fetched on demand — a body runs to thousands of words, so the list carries none of them
    // and opening a row is what pays for one. Its own key per id, so re-opening a row it has already read is free.
    const readBody = (id: string): Promise<SkillBody> =>
        queryClient.fetchQuery({
            queryKey: [...QUERY_KEY, `body`, id],
            queryFn: async (): Promise<SkillBody> => SkillBodySchema.parse(await sandboxJson(`/skills/read?id=${encodeURIComponent(id)}`)),
        });

    // Dropped after a save so re-opening an edited skill shows what was just written rather than what it replaced.
    const forgetBody = (id: string): void => {
        queryClient.removeQueries({ queryKey: [...QUERY_KEY, `body`, id] });
    };

    return {
        skills,
        settings,
        error,
        isLoading: query.isLoading,
        save,
        remove,
        setEnabled,
        readBody,
        forgetBody,
    };
}
