import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A command the extension may register a handler for (api.commands.register); surfaced in the command palette.
export const CommandContributionSchema = z.object({
    command: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    title: z.string().min(1).describe("What the command palette shows. The manifest's value wins over the one passed at registration."),
    icon: z.string().optional().describe("A name from the host's icon set, drawn beside the title."),
    // An optional global keyboard shortcut, in the host's chord notation (`Mod`/`Ctrl`/`Shift`/`Alt` + key, e.g.
    // "Mod+Shift+K"; `Mod` = ⌘ on Apple, Ctrl elsewhere). It is DECLARED here so it rides the install dialog's
    // approval surface — a global shortcut is consequential, so like title/icon the manifest value is authoritative
    // and the host binds only what was approved. Whitespace-free; an unparseable chord simply never fires.
    keybinding: z
        .string()
        .regex(/^\S+$/)
        .optional()
        .describe(
            'A global keyboard shortcut, e.g. "Mod+Shift+K" — `Mod` is ⌘ on Apple and Ctrl elsewhere. Declared here because a global shortcut is consequential: the owner approves it at install, and the host binds only what was approved.',
        ),
});
export type CommandContribution = z.infer<typeof CommandContributionSchema>;

export const commandsPoint = {
    name: "commands",
    description:
        "Commands this extension may register handlers for, surfaced in the command palette. Title, icon and shortcut all come from here rather than from the registration call, because this is what the owner approved at install.",
    schema: z.array(CommandContributionSchema),
} as const satisfies ContributionPoint;
