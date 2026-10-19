// The shell's chunks, named once for the router's start-up warm (router/startHooks.ts) and the shell itself. A dynamic
// import of the same file from anywhere shares one fetch and one module, so the route table's own import of the shell
// finds what the warm already asked for.
export const loadWorkspaceShell = () => import(`./WorkspaceShell.vue`);
export const loadShellDesktop = () => import(`./ShellDesktop.vue`);
export const loadShellMobile = () => import(`./ShellMobile.vue`);
