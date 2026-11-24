// The words of /docs/between-sandboxes/: what your agents can carry from one of your sandboxes to another, told in
// pictures (site/src/components/figures/BetweenSandboxesFigure.astro draws every part). Short on purpose: each picture
// carries the idea, and these are its labels. The rules behind it are docs/architecture/account-routing.md.

export type BetweenSandboxId = "home" | "game" | "work";
export type BetweenThingId = "report" | "drop" | "read" | "task" | "runout";

export interface BetweenSandbox {
    readonly id: BetweenSandboxId;
    readonly name: string;
    /** Whose it is, as you would say it. */
    readonly whose: string;
    /** What you are there. */
    readonly you: string;
}

export interface BetweenThing {
    readonly id: BetweenThingId;
    readonly name: string;
    readonly line: string;
    /** What an agent types, or what happens by itself. */
    readonly how: string;
    readonly automatic?: true;
}

export const betweenSandboxes = {
    label:
        "You are in three sandboxes: Home and Indie game are yours, and Acme portal is Ola's, where you write. Your agents can carry reports, files, looks, tasks and heads-ups between them.",
    you: "You",
    sandboxes: [
        { id: "home", name: "Home", whose: "yours", you: "Owner" },
        { id: "game", name: "Indie game", whose: "yours", you: "Owner" },
        { id: "work", name: "Acme portal", whose: "Ola's", you: "Writer" },
    ] satisfies readonly BetweenSandbox[],

    rule: {
        title: "One rule",
        line: "Your agent can do there exactly what you could do there yourself.",
        label:
            "In Home you are the owner, so everything goes. In Acme portal you write, so files, your own chats and work go. Ola's private sandbox has no place for you, so nothing goes there.",
        places: [
            { id: "home", name: "Home", you: "Owner", can: [true, true, true] },
            { id: "work", name: "Acme portal", you: "Writer", can: [true, true, true] },
            { id: "private", name: "Ola's private", you: "Not in it", can: [false, false, false] },
        ],
        abilities: ["Hand over files", "Have a look", "Start work"],
    },

    things: [
        {
            id: "report",
            name: "Report a problem",
            line: "Lands in the inbox of the sandbox that owns the project.",
            how: "projects report",
        },
        {
            id: "drop",
            name: "Hand over files",
            line: "A note and files. Nothing starts running.",
            how: "sandboxes send",
        },
        {
            id: "read",
            name: "Have a look",
            line: "Read the chats there you could read anyway.",
            how: "agents show --on",
        },
        {
            id: "task",
            name: "Hand over a task",
            line: "It runs there as you. The answer comes back.",
            how: "agents delegate --to",
        },
        {
            id: "runout",
            name: "Out-of-credits heads-up",
            line: "One sandbox runs out, the others signed in to that account know.",
            how: "by itself",
            automatic: true,
        },
    ] satisfies readonly BetweenThing[],

    allow: {
        title: "Allow once",
        line: "The first time, you say yes. After that it just works.",
        card: { ask: "Let Home act as you in Acme portal?", yes: "Allow", no: "Not now" },
        steps: ["Your agent asks", "You press Allow", "Both sides remember"],
        revoke: "Take it back any time",
        label:
            "The first time an agent in Home wants to act as you in Acme portal, a card asks you. You press Allow, and both sandboxes remember it until you take it back.",
    },

    keys: {
        title: "Two keys, one door",
        line: "intentic.dev says who is asking. Only your Allow opens the door.",
        keys: [
            { id: "who", name: "Who's asking", from: "intentic.dev" },
            { id: "yes", name: "Your Allow", from: "you" },
        ],
        alone: "One key alone opens nothing.",
        label: "A sandbox opens only to two keys together: intentic.dev's word on who is asking, and the Allow you gave. Neither works alone.",
    },

    claims: {
        title: "Every project has a home",
        line: "Claim a project once. A problem seen anywhere finds its way there.",
        rows: [
            { repo: "github.com/acme/portal", sandbox: "work" },
            { repo: "github.com/you/game", sandbox: "game" },
            { repo: "github.com/you/home-bot", sandbox: "home" },
        ] satisfies readonly { repo: string; sandbox: BetweenSandboxId }[],
        where: "Settings ▸ Projects",
        label: "Each project is claimed by one sandbox: the Acme portal repository by Acme portal, the game by Indie game, the home bot by Home. A problem reported about a project lands in the sandbox that claims it.",
    },

    stays: {
        title: "What stays put",
        line: "Keys and sign-ins never leave their sandbox.",
        items: ["Passwords", "Sign-ins", "API keys", "Subscriptions"],
        label: "Passwords, sign-ins, API keys and subscriptions stay in the sandbox they were connected to. Only what you hand over travels.",
    },

    org: {
        title: "Crossing a company line",
        line: "Allowed, and always labelled.",
        from: "Acme",
        to: "personal",
        tag: "From Acme → personal",
        label: "When something goes from a company's sandbox to a personal one, it arrives labelled with the line it crossed.",
    },
} as const;
