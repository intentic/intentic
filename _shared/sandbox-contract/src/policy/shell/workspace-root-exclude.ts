// The name of the folder a command run at the workspace root should step over, handed to it in its environment: every
// automation guard gets the reference shelf's (automations/watch/watch-condition.ts), and the maintenance extension's
// probes get it at the workspace root only, since inside one repository a `refs/` directory is ordinary project content.
// In the `chores` subpath until 2026-11-26, which re-exports it until extension API 3.0.0.
export const WORKSPACE_ROOT_EXCLUDE_ENV = `INTENTIC_WORKSPACE_ROOT_EXCLUDE`;

// Unquoted parameter expansion is intentional: when the variable is absent it contributes zero arguments;
// when present, each expression expands to one whitespace-free CLI argument. The daemon supplies the value
// from @intentic/workspace-ignore, never from user input.
export const WORKSPACE_ROOT_RG_EXCLUDE_ARG = `\${${WORKSPACE_ROOT_EXCLUDE_ENV}:+--glob=!/\${${WORKSPACE_ROOT_EXCLUDE_ENV}}/**}`;
export const WORKSPACE_ROOT_JSCPD_EXCLUDE_ARG = `\${${WORKSPACE_ROOT_EXCLUDE_ENV}:+--ignore=\${${WORKSPACE_ROOT_EXCLUDE_ENV}}/**}`;
