import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";

// The role a conversation started under a project wears when nothing else was chosen: opened in the project and
// carrying its repository. (Until 2026-11-18 it was fenced to the project too; a fence is access now, an access profile
// listing the card, which whoever runs people and access sets on Access ▸ Profiles, not something a New agent press may
// write.) One role per project, made the first time
// New agent is pressed there and never rewritten after, so what the owner adds to it (accounts, a brief, a model)
// stays. It is an ordinary role in the roles list: editable, deletable, and the picker can swap it for another.

// `project-` keeps the id inside entryId's alphabet whatever the folder is called; a nested path's slash becomes a
// hyphen, and the whole is cut to the id's limit.
export const projectRoleId = (project: string): string => `project-${project.replace(/[^a-zA-Z0-9_-]+/g, `-`)}`.slice(0, 60);

export const projectRoleRole = (project: string): Role => ({
    id: projectRoleId(project),
    label: project.split(`/`).pop() ?? project,
    capabilities: [],
    workspace: { startIn: project },
    context: { repos: [project] },
});

// The role's id, once it exists: reads the list first so an edited role is never written over.
export const ensureProjectRole = async (project: string): Promise<string> => {
    const id = projectRoleId(project);
    const { roles } = await sandboxRpc.roles.list();
    if (roles.some((role) => role.id === id)) {
        return id;
    }
    await sandboxRpc.roles.save(projectRoleRole(project));
    await queryClient.invalidateQueries({ queryKey: rpcKey(`roles.list`) });
    return id;
};
