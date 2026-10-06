// The JS tool's names, which the mount (execution/js-tool.ts), the `Code` alias and the command guard's matcher
// (guard/command-guard.ts, guard/outside-results.ts) must agree on. Here rather than beside the tool so the guard, which
// sits below the agent layer, can recognise the tool without importing the code that runs it.
export const JS_SERVER_NAME = "code";
export const JS_TOOL_NAME = "mcp__code__run";
export const JS_TOOL_ALIAS = "Code";
