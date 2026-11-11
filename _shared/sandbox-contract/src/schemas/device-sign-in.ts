import { z } from "zod";

// A connection's form signing in on its own with a device code (RFC 8628), for a card whose field declares `signIn` and
// whose manifest says how (`refreshToken.deviceCode`): the provider's endpoints answer no browser, so the sandbox asks
// for the code, and it is the sandbox that asks the provider, while a wait is open, whether the person has finished on
// its page. The token never reaches the browser: the form gets a stash marker (`stashedMarker`, schemas/capabilities.ts)
// for the field, the same way a generated SSH key arrives, and the add that saves the form installs it.

// POST /capabilities/device-sign-in: starts one; the form shows the code with the page and waits on `flow`.
export const DeviceSignInStartSchema = z.object({
    flow: z.string().describe("Stands for this sign-in, to wait on. Lapses with the code."),
    userCode: z.string().describe("What the person types on the provider's page."),
    verificationUri: z.string().describe("The provider's own page for it, to open in a new tab."),
    expiresIn: z.number().describe("Seconds until the code lapses."),
});
export type DeviceSignInStart = z.infer<typeof DeviceSignInStartSchema>;

// POST /capabilities/device-sign-in/wait: answers as soon as the sign-in ends, or `waiting` after a while.
export const DeviceSignInWaitInputSchema = z.object({ flow: z.string().min(1).describe("The sign-in, as its start answered.") });
export const DeviceSignInWaitSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("waiting").describe("Nobody has finished on the provider's page yet. Ask again.") }),
    z.object({
        state: z.literal("done"),
        token: z
            .string()
            .describe(
                "Stands for the refresh token, which never leaves the sandbox. Sent wrapped as a stash marker in the field that declares `signIn`, it installs that token once, while the fields the sign-in is bound to still hold what they held; it lapses after thirty minutes.",
            ),
        who: z.string().optional().describe("Who signed in, as the card's own test or the sign-in itself names them."),
        granted: z.array(z.string()).describe("What the provider granted, each permission by its short name (`Mail.Read`)."),
        bound: z
            .array(z.string())
            .describe("The fields the sign-in is only good for as they are now (`refreshToken.boundTo`): changing one before Save needs a new sign-in."),
    }),
    z.object({ state: z.literal("failed"), message: z.string().describe("Why it did not finish, in words a person can act on.") }),
]);
export type DeviceSignInWait = z.infer<typeof DeviceSignInWaitSchema>;
