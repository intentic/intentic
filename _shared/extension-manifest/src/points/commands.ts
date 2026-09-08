import { isWhenExpression } from "@intentic/base/when";
import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A command the extension may register a handler for (api.commands.register); surfaced in the command palette.
export const CommandContributionSchema = z.object({
    command: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    title: z.string().min(1).describe("What the command palette shows. The manifest's value wins over the one passed at registration."),
    icon: z.string().optional().describe("A name from the host's icon set, drawn beside the title."),
    // Global keyboard shortcut in the host's chord notation. Declared here so it rides the install dialog's approval;
    // the host binds only what was approved.
    keybinding: z
        .string()
        .regex(/^\S+$/)
        .optional()
        .describe(
            'A global keyboard shortcut, e.g. "Mod+Shift+K" — `Mod` is ⌘ on Apple and Ctrl elsewhere. Declared here because a global shortcut is consequential: the owner approves it at install, and the host binds only what was approved.',
        ),
    // When the keybinding applies, as a condition over the shell's context keys; the palette ignores it since a command
    // is always runnable by name. Without one the chord is claimed everywhere, including inside a terminal.
    when: z
        .string()
        .refine(isWhenExpression, { message: "not a valid `when` condition" })
        .optional()
        .describe(
            "When the shortcut applies, as a condition over the shell's context keys, `tabSurface == 'chat'`, `!editableTarget`. Without one the chord is claimed everywhere, including inside a terminal where a bare key belongs to the program running in it. The command palette ignores this: a command is always runnable by name.",
        ),
});
export type CommandContribution = z.infer<typeof CommandContributionSchema>;

export const commandsPoint = {
    name: "commands",
    description:
        "Commands this extension may register handlers for, surfaced in the command palette. Title, icon and shortcut all come from here rather than from the registration call, because this is what the owner approved at install.",
    schema: z.array(CommandContributionSchema),
} as const satisfies ContributionPoint;
