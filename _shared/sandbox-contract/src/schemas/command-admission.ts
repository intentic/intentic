import { z } from "zod";

// The class of thing asking to start a session, the admission policy's key space; derived daemon-side, never sent by a
// client. Chat and loops are absent since both begin with the owner's own click.
export const WakeSourceSchema = z.enum(["schedule", "event", "listener", "webchat", "issues", "workspace", "workflow"]);
export type WakeSource = z.infer<typeof WakeSourceSchema>;
// One admission verdict the owner can configure: let it run, hold it for approval, or refuse it outright.
export const AdmissionRuleSchema = z.enum(["allow", "hold", "deny"]);
export type AdmissionRule = z.infer<typeof AdmissionRuleSchema>;
// Where a command would run; the same string means different things on each machine (rm -rf /usr is recoverable here,
// fatal on a laptop). Read with a locus (command-classes.ts CommandContext); callers must state one rather than
// default.
export const CommandLocusSchema = z.enum([
    // This sandbox's own shell: a disposable container, /work a git worktree, /history every other agent's.
    "sandbox",
    // One of the owner's own computers, reached through the machine agent. Nothing here is disposable.
    "device",
]);
export type CommandLocus = z.infer<typeof CommandLocusSchema>;
// What kind of thing a shell command is, the command gate's key space under the admission floor; gates one command
// inside an already-running session. Six classes, chosen because each is hard or impossible to undo somewhere.
export const CommandClassSchema = z.enum([
    // Rewrites or discards committed work: force-push, hard reset, force-delete a branch, clean -f, filter-branch.
    "git.destructive",
    // Moves a checkout to another branch. Only ever matches in a tree the conversation SHARES with its owner: inside
    // its own copy a conversation may stand where it likes, and the drift that causes is reported, not refused.
    "git.branch-switch",
    // Recursive-force deletion (`rm -rf`), and its spelling in a script (`fs.rm(p, { recursive: true })`).
    "files.destructive",
    // State nothing recovers at this locus; which roots count (/, /history in the sandbox) depends on the locus.
    "system.destructive",
    // A container volume or its data; the sandbox's blast radius (nested engine) differs sharply from a device's.
    "container.state",
    // Reads credential material: a secret reference, or a file confirmed to actually hold one.
    "secrets.access",
    // Publishes outward and irreversibly: npm/pnpm/yarn/cargo publish, gh release create, docker push.
    "package.publish",
    // A network program (curl, nc, ssh, scp, …) or interpreter one-liner aimed at a non-loopback or run-time-built
    // destination, the general exfiltration channel under the per-provider actionRules.
    "network.outbound",
]);
export type CommandClass = z.infer<typeof CommandClassSchema>;
// Workspace-wide admission floor per wake source, consulted on every outside-driven wake; composes with per-automation
// overrides most-restrictive-wins. `workflow` is allow|deny only, since a hold there is indistinguishable from a CI
// runner's timeout.
export const AdmissionPolicySchema = z.object({
    schedule: AdmissionRuleSchema.default("allow"),
    event: AdmissionRuleSchema.default("allow"),
    listener: AdmissionRuleSchema.default("allow"),
    webchat: AdmissionRuleSchema.default("allow"),
    // Defaults to hold, unlike the others: a bug-report wake has full repo powers and a stranger's stack trace as its
    // brief.
    issues: AdmissionRuleSchema.default("hold"),
    workspace: AdmissionRuleSchema.default("allow"),
    workflow: z.enum(["allow", "deny"]).default("allow"),
});
export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;
