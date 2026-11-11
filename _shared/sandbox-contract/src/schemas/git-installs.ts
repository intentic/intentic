// The two capability kinds installed from a git repository, a Claude Code plugin and an intentic extension: their
// config arms of CapabilitySchema (capabilities.ts), with the repository, the version and the credential each reads it
// with.
import { z } from "zod";
import { entryId } from "./internal.js";

// (2026-11-11) A plugin's or extension's GitHub or GitLab card, named so a second card for the same host never changes
// which account an install reads with; absent, policy/git/git-connections.ts picks one.
const gitConnection = entryId
    .optional()
    .describe(
        "The GitHub or GitLab connection, by its id, whose token reads a private repository on its host. Used when no token is given; left out, the first such connection by id is used, and none means the repository is read without a credential.",
    );
// A Claude Code plugin from a git repo; the daemon only owns the checkout, the Agent SDK's plugin loader reads its
// internals. `path` is a subdirectory for a plugin inside a larger checkout; `token` is https auth for a private repo.
export const PluginConfigSchema = z.object({
    url: z.url().describe("The repository to take the plugin from."),
    // Branch / tag / commit sha to install from; absent = the default branch's HEAD. Either way `commit` pins it.
    ref: z
        .string()
        .min(1)
        .optional()
        .describe(
            "A branch, tag or commit to install from. Leave it out for the default branch. The install pins the commit it names at that moment.",
        ),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional()
        .describe("Where inside the repository the plugin lives, for one that sits in a larger checkout."),
    token: z.string().min(1).optional().describe("A credential for a private repository. Stored, never echoed back."),
    gitConnection,
    // Set by the sandbox at install, never by the form: re-applying a stored entry (a rotated token, a migration)
    // checks this out again, and only adding the plugin anew moves it.
    commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/, "commit must be a full 40-character commit sha")
        .optional()
        .describe(
            "The exact commit installed, in full, resolved from the branch, tag or commit when the plugin was added. Its hooks run inside the agent's session, so it stays at this commit until it is added again.",
        ),
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
// An intentic extension from a git repo (UI bundle + agent contributions + processes). Unlike `plugin`, `ref` must be a
// full commit sha, since extension code runs trusted in the owner's browser and every update is a deliberate re-add at
// a new sha.
export const ExtensionConfigSchema = z.object({
    url: z.url().describe("The repository to take the extension from."),
    ref: z
        .string()
        .regex(/^[0-9a-f]{40}$/, "ref must be a full 40-character commit sha")
        .describe(
            "The exact commit to install, in full. Required rather than optional because extension code runs with your browser's trust: the owner approves precisely the code that runs, and an update is a deliberate re-install at a new commit.",
        ),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional()
        .describe("Where inside the repository the extension lives, for one that sits in a larger checkout."),
    token: z.string().min(1).optional().describe("A credential for a private repository. Stored, never echoed back."),
    gitConnection,
    // What update checks and advisories are read against; absent falls back to the official registry.
    registry: z
        .url()
        .optional()
        .describe(
            "Which registry this install came from, which is what update checks and security advisories are read against. Absent falls back to the official one.",
        ),
});
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
