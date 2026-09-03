/* THE AUTOMATION MACHINE, IN WORDS. One source, two placements: the Automate stage on the home page and the
 * hero figure on /features/automate/. Both draw the same three stations, so the words are here rather than in
 * either page — a reader who meets the diagram twice should meet the same claim twice, not a paraphrase.
 *
 * The three stations are the machine's three moves and nothing else: what wakes a run, the code of yours that
 * gets to veto it, and what a run turns out to be. The middle one is the part nobody expects, and it is why
 * this is a drawing rather than a list — an event does not start an agent, your own check does.
 *
 * WHAT IS NOT HERE: the numerals on the stations, the icons, the arrowheads. Those are the drawing's own and
 * live with the component (`AutomateFigure.astro`), the same way `navIcons.ts` holds the menu's marks. This
 * file holds sentences a person reads.
 */

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
    /* The check, drawn as a gate with two exits. `pass` and `skip` are the labels ON the two paths, and they
     * carry the mechanism verbatim from the docs: exit 0 wakes the agent, anything else is recorded as
     * skipped. Stating the exit code is what stops "an optional check" reading as a setting rather than as
     * your own code. */
    check: {
        eyebrow: string;
        title: string;
        body: string;
        optional: string;
        /** A real one-liner, because "your own command" is a claim a reader should be able to picture. */
        example: { caption: string; command: string };
        pass: { code: string; note: string };
        skip: { code: string; note: string };
    };
    /** What a run turns out to be. The three points are the product's whole promise, in the order it happens. */
    run: { eyebrow: string; title: string; points: string[] };
    /** The spoken version: what a screen reader gets INSTEAD of the shape, so it has to carry the sequence. */
    label: string;
}

export const automateMachine: AutomateMachine = {
    events: {
        eyebrow: "Wakes on",
        // Six, because six is what the product has, and each names the system it comes from: "an alert" is a
        // category, "Alert · Sentry" is something a reader can check against their own stack.
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
        // Shell a reader can evaluate at a glance: is there anything to do? Kept SHORT on purpose — this line
        // sets on one line inside a panel that is 180px wide on a laptop, and a command that wraps stops being
        // an example of the idea and starts being a snippet to parse.
        example: { caption: "for example", command: 'test -n "$(git diff)"' },
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
        "An optional command of yours reads the event first — exit 0 and an agent wakes, anything else is recorded as skipped and costs nothing. " +
        "A run is a fresh agent session on your board, with its own transcript, its own branch and checkout, and nothing landing until you have read the diff.",
};
