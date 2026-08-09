import { useQueryClient } from "@tanstack/vue-query";
import { ref } from "vue";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxJson } from "../sandbox/sandboxClient";
import { panelsKey } from "../extensions/usePanels";
import { repoNameFromUrl } from "./repoName";

/* CLONING A REPOSITORY INTO THE WORKSPACE — the daemon has offered this since the workspace did (POST
 * /workspace/repos), and nothing in the app called it. Which left uploading the only way in: most people's code
 * is on a host, and the one screen that greets an empty workspace asked them to drag a folder into the browser.
 *
 * The clone lands at /work/<name>, where <name> is derived from the URL — the daemon reserves a handful of
 * names (role scaffolding, "root", the reference shelf, the outbox) and refuses anything outside a safe
 * segment, so its verdict is the one that counts and its message is what the caller shows. Nothing is
 * pre-validated here beyond "there is a name to send": a second, drifting copy of that rule in the browser is
 * how a clone the daemon would have accepted comes to be refused by a form. */

export function useAddRepo() {
    const queryClient = useQueryClient();
    const cloning = ref(false);
    const error = ref<string | undefined>(undefined);

    /* Clone, then refresh everything a new repo changes: the file tree it appears in, the panel list the rail
     * detects its extension tiles from, the repo list the tree's git affordances read, and the changes scan
     * (a fresh checkout re-frames what "the root scope" holds — see git.routes). Returns whether it landed, so
     * the caller can close its form on success and keep the typed URL on failure. */
    const addRepo = async (cloneUrl: string): Promise<boolean> => {
        const url = cloneUrl.trim();
        const name = repoNameFromUrl(url);
        if (url.length === 0 || name.length === 0) {
            error.value = `That doesn't look like a repository address.`;
            return false;
        }
        cloning.value = true;
        error.value = undefined;
        try {
            await sandboxJson(`/workspace/repos`, jsonBody(`POST`, { name, cloneUrl: url }));
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }),
                queryClient.invalidateQueries({ queryKey: panelsKey }),
                queryClient.invalidateQueries({ queryKey: [`git`, `repos`] }),
                queryClient.invalidateQueries({ queryKey: [`git`, `changes`] }),
            ]);
            return true;
        } catch (cause) {
            // The daemon's own sentence (sandboxError puts it on `message`) — it is the one that knows whether
            // this was a reserved name, an unreachable host, or a private repo with no credentials configured.
            error.value = cause instanceof Error ? cause.message : `Couldn't clone that repository.`;
            return false;
        } finally {
            cloning.value = false;
        }
    };

    return { addRepo, cloning, error };
}
