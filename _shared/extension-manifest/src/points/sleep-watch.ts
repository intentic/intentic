import { z } from "zod";
import type { CapabilityField } from "./capabilities.js";

/* (2026-11-27) WHAT INTENTIC'S SERVERS MAY HOLD FOR A CARD WHILE A HOSTED SANDBOX SLEEPS. Credentials stay in the sandbox,
 * with one exception: a service that delivers only over a live connection (Discord's gateway) can be heard while the
 * machine sleeps only by something outside it holding that connection. A cli card declares which of its fields holds
 * the credential and which switch is the owner's yes for one connection; the daemon hands the credential to the
 * platform right before a sleep only for a connection whose switch is on, on a hosted sandbox, while an automation
 * listens on the card's provider, and the platform deletes it when the sandbox wakes. The services the platform speaks
 * are a closed list: a declaration naming another would hand a credential to nothing. */

// The connections the platform's sleep watcher can hold: `discord`, a bot's gateway connection.
export const SLEEP_WATCH_SERVICES = ["discord"] as const;
export type SleepWatchService = (typeof SLEEP_WATCH_SERVICES)[number];

export const SleepWatchSchema = z
    .object({
        service: z
            .enum(SLEEP_WATCH_SERVICES)
            .describe("The connection Intentic's servers hold for it while the sandbox sleeps: `discord`, the bot's gateway connection, the only one they speak."),
        credential: z.string().describe("The secret field holding the credential they hold (a bot token)."),
        consent: z
            .string()
            .describe(
                "The switch (`boolean: true`, `hosted: true`, off by default) that is the owner's yes for one connection. Off, or on a sandbox on the owner's own computer, nothing leaves the sandbox. Its label or hint must say exactly what happens.",
            ),
    })
    .describe(
        "Lets Intentic's servers hold this card's credential while a hosted sandbox sleeps, to notice what the service delivers only over a live connection and wake the sandbox for it: only for a connection whose owner turned the `consent` switch on, only while an automation listens on this card's provider, and only until the sandbox wakes, when it is deleted. The one exception to credentials staying in the sandbox.",
    );
export type SleepWatch = z.infer<typeof SleepWatchSchema>;

// Why a card's declaration cannot stand against its own fields: a credential that is not a secret field, or a consent
// that is not an off-by-default, hosted-only switch.
export const sleepWatchProblems = (watch: SleepWatch, fields: readonly CapabilityField[]): string[] => {
    const declared = new Map(fields.map((field) => [field.key, field]));
    const problems: string[] = [];
    if (declared.get(watch.credential)?.secret !== true) {
        problems.push(`sleepWatch.credential "${watch.credential}" must name a secret field`);
    }
    const consent = declared.get(watch.consent);
    if (consent?.boolean !== true || consent.hosted !== true || (consent.default ?? "off") !== "off") {
        problems.push(
            `sleepWatch.consent "${watch.consent}" must name a switch (\`boolean: true\`) drawn only on hosted sandboxes (\`hosted: true\`) and off by default`,
        );
    }
    return problems;
};

// Whether a stored connection's answer to the consent switch is yes: the form stores a switch as "on"/"off".
export const sleepWatchConsented = (watch: SleepWatch, config: Readonly<Record<string, string | number | boolean | undefined>>): boolean => {
    const answer = config[watch.consent];
    return answer === "on" || answer === true;
};
