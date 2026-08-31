/* Maintenance probes normally run inside one discovered repository, where a `refs/` directory is ordinary
 * project content. They also run once against the workspace root, where the same first segment is the reserved
 * reference shelf and can hold hundreds of thousands of files. The daemon sets this variable only for that
 * root scope; shell commands opt into the matching prune argument without baking the shelf's name into the
 * browser-safe contract package. */
export const WORKSPACE_ROOT_EXCLUDE_ENV = `INTENTIC_WORKSPACE_ROOT_EXCLUDE`;

// Unquoted parameter expansion is intentional: when the variable is absent it contributes zero arguments;
// when present, each expression expands to one whitespace-free CLI argument. The daemon supplies the value
// from @intentic/workspace-ignore, never from user input.
export const WORKSPACE_ROOT_RG_EXCLUDE_ARG = `\${${WORKSPACE_ROOT_EXCLUDE_ENV}:+--glob=!/\${${WORKSPACE_ROOT_EXCLUDE_ENV}}/**}`;
export const WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG = `\${${WORKSPACE_ROOT_EXCLUDE_ENV}:+--ignore=\${${WORKSPACE_ROOT_EXCLUDE_ENV}}/**}`;
