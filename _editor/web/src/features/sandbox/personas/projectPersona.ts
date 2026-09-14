import { type Persona, PersonasListSchema } from "@intentic/sandbox-contract";
import { PERSONAS } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";

// The persona a conversation started under a project wears when nothing else was chosen: opened in the project,
// fenced to it (file tools refuse outside it), carrying its repository. One card per project, made the first time
// New agent is pressed there and never rewritten after, so what the owner adds to it (accounts, a brief, a model)
// stays. It is an ordinary card in the personas list: editable, deletable, and the picker can swap it for another.

// `project-` keeps the id inside entryId's alphabet whatever the folder is called; a nested path's slash becomes a
// hyphen, and the whole is cut to the id's limit.
export const projectPersonaId = (project: string): string => `project-${project.replace(/[^a-zA-Z0-9_-]+/g, `-`)}`.slice(0, 60);

export const projectPersonaCard = (project: string): Persona => ({
    id: projectPersonaId(project),
    label: project.split(`/`).pop() ?? project,
    capabilities: [],
    workspace: { startIn: project, folders: [project] },
    context: { repos: [project] },
});

// The card's id, once it exists: reads the list first so an edited card is never written over.
export const ensureProjectPersona = async (project: string): Promise<string> => {
    const id = projectPersonaId(project);
    const { personas } = PersonasListSchema.parse(await sandboxJson(`/personas`));
    if (personas.some((card) => card.id === id)) {
        return id;
    }
    await sandboxJson(`/personas`, jsonBody(`POST`, projectPersonaCard(project)));
    await queryClient.invalidateQueries({ queryKey: PERSONAS.of() });
    return id;
};
