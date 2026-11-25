import { z } from "zod";

// What a need asks for (needs.ts), one word per kind; each kind's subject and ask live in needs.ts, and the deploy
// need's in deploys.ts. Its own module so the list can grow without pushing needs.ts past its size.

const FIRST_KINDS = ["capability", "secret", "grant", "release", "environment", "automation", "instruction", "host-power"] as const;
export const NEED_KINDS = [...FIRST_KINDS, "claim", "route", "redirect", "deploy"] as const;
export const NeedKindSchema = z
    .enum(NEED_KINDS)
    .describe(
        "What is being asked for: a connection, a secret's value, wider reach, a gated credential, a tool in the image, an automation to run unattended, a standing rule written into an AGENTS.md, power settings changed on the computer this sandbox runs on, a project claimed for this sandbox so the owner's other sandboxes report its problems here, a person's leave for this sandbox to act as them in another, a person's message sent on to the sandbox it was meant for, or a managed stack let receive the secrets its manifest reads.",
    );
export type NeedKind = z.infer<typeof NeedKindSchema>;
