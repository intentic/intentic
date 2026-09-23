import type { Persona } from "@intentic/sandbox-contract";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { sandboxRpc } from "../client/sandboxRpc";

// The persona a conversation started under a project wears when nothing else was chosen: opened in the project,
// fenced to it (file tools refuse outside it), carrying its repository. One persona per project, made the first time
// New agent is pressed there and never rewritten after, so what the owner adds to it (accounts, a brief, a model)
// stays. It is an ordinary persona in the personas list: editable, deletable, and the picker can swap it for another.

// `project-` keeps the id inside entryId's alphabet whatever the folder is called; a nested path's slash becomes a
// hyphen, and the whole is cut to the id's limit.
export const projectPersonaId = (project: string): string => `project-${project.replace(/[^a-zA-Z0-9_-]+/g, `-`)}`.slice(0, 60);

export const projectPersonaPersona = (project: string): Persona => ({
    id: projectPersonaId(project),
    label: project.split(`/`).pop() ?? project,
    capabilities: [],
    workspace: { startIn: project, folders: [project] },
    context: { repos: [project] },
});

// The persona's id, once it exists: reads the list first so an edited persona is never written over.
export const ensureProjectPersona = async (project: string): Promise<string> => {
    const id = projectPersonaId(project);
    const { personas } = await sandboxRpc.personas.list();
    if (personas.some((persona) => persona.id === id)) {
        return id;
    }
    await sandboxRpc.personas.save(projectPersonaPersona(project));
    await queryClient.invalidateQueries({ queryKey: rpcKey(`personas.list`) });
    return id;
};
