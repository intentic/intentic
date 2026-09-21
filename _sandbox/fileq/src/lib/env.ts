/* Where fileq stands: the workspace it derives for, beyond the shared agent-CLI layout (@intentic/agent-cli/env). */

// Unset means "no workspace": a file read from outside one still derives, it just gets no sidecar.
export const workspaceRoot = (): string | undefined => {
    const root = process.env["WORKSPACE_ROOT"];
    return root === undefined || root === "" ? undefined : root;
};
