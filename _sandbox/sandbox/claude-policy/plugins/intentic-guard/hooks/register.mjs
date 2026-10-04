// Intentic's policy mod for Claude Code. Loaded first (managed `prependPlugins`, ../../../managed-settings.json), it
// holds one line: whether a tool call runs is decided by the sandbox, not by a mod someone installed.
//
// The daemon's guards (the command gate, secret rewriting and redaction, action rules, persona scope) are Agent SDK
// callback hooks, which Claude Code dispatches as `classic.*` events and settles in `tool.check`. A user's mod runs
// before both: answering `classic.PreToolUse` without passing it on means the daemon's hook never runs, and answering
// `tool.check` with allow overturns its deny. Claude Code's own guard (`sec-default@builtin`) only holds hooks that
// managed settings declare, which the daemon's are not. Measured on CLI 2.1.288 against a scripted model: both
// routes ran a command the daemon had refused, and with this mod first neither did.
//
// `next.to(e, "builtin")` skips the users' mods for these events and lets the built-in mods and Claude Code's own
// dispatch (settings hooks, plugin shell hooks, SDK callbacks) decide. A user's mod keeps every other event, including
// `tool.call`, where it can still refuse a call or ask before one.
const decidedBySandbox = ($, e, next) => next.to(e, "builtin");

export function register(on) {
    on("tool.check", decidedBySandbox);
    on("classic.*", decidedBySandbox);
}
