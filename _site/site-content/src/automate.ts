// Shared source for the Automate stage on the home page and the /features/automate/ hero figure: both draw the same
// three stations (what wakes a run, the check that can veto it, what a run becomes). Icons and numerals live with
// `AutomateFigure.astro`; this file holds only the sentences.

/** One thing that can wake a run: the event as a noun, and where it comes from. */
export interface AutomateTrigger {
    /** The event itself, capitalised as the chip prints it. */
    label: string;
    /** The provider or mechanism behind it — what makes the row checkable rather than a category. */
    source: string;
    /** Key into the figure's own icon table. A key with no drawing simply renders no icon. */
    icon: "push" | "alert" | "payment" | "email" | "message" | "schedule";
}

export interface AutomateMachine {
    events: { eyebrow: string; items: AutomateTrigger[] };
    // The check: a gate with two exits, `pass`/`skip`; exit 0 wakes the agent, anything else is skipped.
    check: {
        eyebrow: string;
        title: string;
        body: string;
        optional: string;
        /** A concrete command, not a placeholder. */
        example: { caption: string; command: string };
        pass: { code: string; note: string };
        skip: { code: string; note: string };
    };
    /** What a run turns out to be; points are listed in the order they happen. */
    run: { eyebrow: string; title: string; points: string[] };
    /** Spoken equivalent of the diagram, for screen readers; must carry the full sequence. */
    label: string;
}

export const automateMachine: AutomateMachine = {
    events: {
        eyebrow: "Wakes on",
        // Each item names the concrete system it comes from, not a category.
        items: [
            { label: "A push", source: "GitHub · GitLab", icon: "push" },
            { label: "An alert", source: "Sentry", icon: "alert" },
            { label: "A payment", source: "Stripe", icon: "payment" },
            { label: "An email", source: "any IMAP inbox", icon: "email" },
            { label: "A message", source: "Discord · Slack", icon: "message" },
            { label: "A schedule", source: "cron", icon: "schedule" },
        ],
    },
    check: {
        eyebrow: "Your check",
        title: "Your own command reads the event first",
        body: "One line, run in your workspace, that decides whether this particular event is worth waking an agent for.",
        optional: "optional",
        // Keep short: this sets on one line in a narrow panel; a wrapped command stops reading as an example.
        example: { caption: "a nightly sweep", command: 'test -n "$(git diff)"' },
        pass: { code: "exit 0", note: "wake an agent" },
        skip: { code: "anything else", note: "skipped, nothing spent" },
    },
    run: {
        eyebrow: "The run",
        title: "A fresh agent session",
        points: ["Opens on your board, with its own transcript", "Its own branch and checkout", "Nothing lands until you have read the diff"],
    },
    label:
        "How an automation runs: a push, an alert, a payment, an email, a message or a schedule wakes it. " +
        "An optional command of yours reads the event first: exit 0 and an agent wakes, anything else is recorded as skipped and costs nothing. " +
        "A run is a fresh agent session on your board, with its own transcript, its own branch and checkout, and nothing landing until you have read the diff.",
};
