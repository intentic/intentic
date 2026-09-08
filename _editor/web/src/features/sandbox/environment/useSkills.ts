import { type SkillBody, SkillBodySchema, type SkillDraft, type SkillSummary, type SkillSwitch, SkillsListSchema } from "@intentic/api-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { SKILLS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../client/useSandboxQuery";
import { useSandboxSettings } from "../overview/useSandboxSettings";

// What the agent knows: the list is a daemon read, since only the daemon sees all the sources a skill can arrive from.
// Switching a baked tool is a settings write riding useSandboxSettings' optimistic write; switching one of the owner's
// own is its own call, since the settings list has no say over the owner's files. Only the list needs refetching after
// either, since enabled state comes from the daemon's own join.

const QUERY_KEY = SKILLS.of();

export function useSkills() {
    const queryClient = useQueryClient();
    const { settings, patch } = useSandboxSettings();

    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<SkillSummary[]> => SkillsListSchema.parse(await sandboxJson(`/skills`)),
    });

    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    // Upserts by name; refetches rather than patching a row in place, since the daemon (not the form) decides whether a
    // new skill starts enabled.
    const save = useMutation({
        mutationFn: (draft: SkillDraft) => sandboxJson(`/skills`, jsonBody(`POST`, draft)),
        onSuccess: invalidate,
    });

    const remove = useMutation({
        mutationFn: (name: string) => sandboxJson(`/skills/remove`, jsonBody(`POST`, { name })),
        onSuccess: invalidate,
    });

    const switchOwn = useMutation({
        mutationFn: (input: SkillSwitch) => sandboxJson(`/skills/switch`, jsonBody(`POST`, input)),
        onSuccess: invalidate,
    });

    const skills = computed<SkillSummary[]>(() => query.data.value ?? []);

    // Two doors, by origin. A baked tool edits the settings' skills array directly, not the rows on screen: rebuilding
    // it from displayed rows would drop an enabled skill the daemon doesn't currently list as a row.
    const setEnabled = (skill: SkillSummary, enabled: boolean): void => {
        if (skill.origin === `own`) {
            switchOwn.mutate({ name: skill.name, on: enabled });
            return;
        }
        const current = settings.value?.skills;
        if (current === undefined) {
            return;
        }
        patch({ skills: enabled ? [...new Set([...current, skill.name])] : current.filter((entry) => entry !== skill.name) });
        void invalidate();
    };

    // Fetched on demand, since a skill's body can run to thousands of words; keyed per id so re-opening an already-read
    // row is free.
    const readBody = (id: string): Promise<SkillBody> =>
        queryClient.fetchQuery({
            queryKey: [...QUERY_KEY, `body`, id],
            queryFn: async (): Promise<SkillBody> => SkillBodySchema.parse(await sandboxJson(`/skills/read?id=${encodeURIComponent(id)}`)),
        });

    // Dropped after a save, so re-opening shows what was just written, not the old cached body.
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
