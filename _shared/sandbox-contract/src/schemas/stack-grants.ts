import { z } from "zod";
import { StackNameSchema } from "./device-stacks.js";

/* WHICH SECRETS A STACK MAY RECEIVE (2026-11-25). Managed stacks are the Deployments extension's: its engine reads a
   repository's stacks manifest, queues, triggers, rolls back (extensions/deployments). The one thing it cannot do is
   hold a secret's value, so a managed deploy (device-stacks.ts DeviceStackManagedDeployInputSchema) sends `{{secret:…}}`
   references and the daemon fills them, but only the names the OWNER granted that stack, on that computer, from that
   repository. A grant lives in the auth root, where no agent and no extension can write it; an agent asks for one on a
   card (a `deploy` need), the owner's press writes it, and the Deployments board's owner-only button does the same. */

// A stack, from a repository, on one computer (its device card's id): what a grant is for. Moving a stack to another
// computer, or declaring it in another repository, needs a grant of its own.
export const StackGrantRefSchema = z.object({
    repo: z.string().min(1).max(500),
    stack: StackNameSchema,
    device: z.string().min(1).max(200),
});
export type StackGrantRef = z.infer<typeof StackGrantRefSchema>;

const SecretNameSchema = z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/, "a secret's name as `{{secret:NAME}}` writes it");

export const StackGrantSchema = StackGrantRefSchema.extend({
    secrets: z.array(z.string()),
    grantedBy: z.string().optional(),
    grantedAt: z.string(),
});
export type StackGrant = z.infer<typeof StackGrantSchema>;

export const StackGrantsResponseSchema = z.object({ grants: z.array(StackGrantSchema) });
export type StackGrantsResponse = z.infer<typeof StackGrantsResponseSchema>;

// The owner's grant: exactly these names, added to what the stack already holds there.
export const StackGrantSetSchema = StackGrantRefSchema.extend({ secrets: z.array(SecretNameSchema).min(1).max(100) });
export type StackGrantSet = z.infer<typeof StackGrantSetSchema>;

// An agent's ask: a card in its conversation listing the names; answered as a raised need is (needs.ts NeedRaisedSchema).
export const StackGrantRequestSchema = StackGrantSetSchema.extend({ why: z.string().max(280).optional() });
export type StackGrantRequest = z.infer<typeof StackGrantRequestSchema>;

// The owner's card (needs.ts, kind `deploy`). Only the owner, or someone with Full access, signed in, can press it, and
// a yes grants exactly the names the card showed, on the computer it showed.
export const DeployNeedSchema = z.object({
    kind: z.literal("deploy"),
    repo: z.string().min(1).max(500).describe("The repository that declares the stack, workspace-relative."),
    stack: StackNameSchema.describe("The stack's name."),
    device: z.string().min(1).max(200).describe("The computer it deploys to, by its device card: a grant is for that computer alone."),
    deviceName: z.string().max(200).optional().describe("That computer's name, for the card."),
    secrets: z.array(z.string()).describe("The secret names a yes grants it."),
    ungranted: z.array(z.string()).describe("Those it has not been granted yet, when the card was raised."),
});
export type DeployNeed = z.infer<typeof DeployNeedSchema>;
// What an agent sends: the stack and the names (`secrets grant-stack`).
export const DeployNeedAskSchema = z.object({
    kind: z.literal("deploy"),
    repo: z.string().min(1).max(500),
    stack: StackNameSchema,
    device: z.string().min(1).max(200),
    secrets: z.array(SecretNameSchema).min(1).max(100),
});
