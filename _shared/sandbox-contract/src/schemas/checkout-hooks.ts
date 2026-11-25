import { STATE_DIR } from "@intentic/constants";
import { z } from "zod";

// <repo>/.intentic/checkout.json declares what runs around a conversation's own checkout of the repository, beside
// run.json (run-targets.ts), which declares what the repository can run:
// - `setup`, once when the checkout is created, before the conversation's turn starts (installing what a fresh tree
//   lacks, seeding a dev database).
// - `archive`, before the checkout is removed (dumping state somewhere it outlives the checkout). A failure holds the
//   removal back.
// Each runs from the checkout's root, and only once the owner has approved its exact content (the command and the bytes
// of the files it runs), so a branch that edits either asks again (conversations/worktrees/lifecycle/checkout-hooks.ts).

export const CHECKOUT_HOOKS_FILE = `${STATE_DIR}/checkout.json`;

// The longest a hook may run before it is stopped and counted as failed.
export const MAX_CHECKOUT_HOOK_SECONDS = 1800;

const RepoFileSchema = z
    .string()
    .min(1)
    .max(500)
    .refine((path) => !path.startsWith("/") && !path.split(/[\\/]/).includes(".."), "a path inside the repository, relative to its root");

export const CheckoutHookSchema = z
    .object({
        // A shell command, run with `sh -c` from the checkout's root.
        command: z.string().min(1).max(4000),
        // Files the approval pins beside the command, for a script that the command reaches indirectly. A file the
        // command names by its repository path is pinned without being listed.
        files: z.array(RepoFileSchema).max(20).default([]),
        timeoutSeconds: z.int().min(1).max(MAX_CHECKOUT_HOOK_SECONDS).default(300),
    })
    .strict();
export type CheckoutHook = z.infer<typeof CheckoutHookSchema>;

export const CheckoutHooksFileSchema = z
    .object({
        setup: CheckoutHookSchema.optional(),
        archive: CheckoutHookSchema.optional(),
    })
    .strict();
export type CheckoutHooksFile = z.infer<typeof CheckoutHooksFileSchema>;

export type CheckoutHookKind = keyof CheckoutHooksFile;
