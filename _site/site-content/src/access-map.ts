// The words and the sample sandbox of the home page's access band (`AccessMapFigure.astro`): the public redraw of the
// app's Sandbox ▸ Map (`_editor/web/src/features/sandbox/map/`). Who gets in on the left, the box with its areas,
// personas and secrets in the middle, and everything it reaches on the right.
//
// The sample is invented, but every line of it follows the rules the daemon enforces and the app's map draws
// (`reachModel.ts`): a writer edits only inside the areas they hold, a person's agents carry only the keys their grant
// lists, a guest acts only through the personas homed in their area, a control token is limited by its scope alone, and
// a linked sandbox's tasks run as the persona its link names. Change a principal here and check it against those rules.

/** How a way in reaches one thing: changes it by hand, only reads it, acts through it, or acts through it only as a
 *  persona. The same four the app's map tells apart. */
export type AccessHow = "edit" | "see" | "use" | "through";

export type AccessAreaId = "area:support" | "area:storefront" | "rest";
export type AccessPersonaId = "persona:maya" | "persona:owen";
export type AccessOutwardId =
    | "cap:github"
    | "cap:stripe"
    | "cap:sentry"
    | "cap:zendesk"
    | "cap:posthog"
    | "cap:gmail"
    | "cap:x"
    | "cap:office-pc"
    | "cap:ops-box"
    | "cap:release-box"
    | "port:3000"
    | "outbox"
    | "model:claude"
    | "model:codex";
export type AccessNodeId = AccessAreaId | AccessPersonaId | "secrets" | AccessOutwardId;

export type AccessGroupKey = "services" | "accounts" | "machines" | "sandboxes" | "network" | "models";
export type AccessClusterKey = "people" | "programs" | "sandboxes";

export interface AccessArea {
    id: AccessAreaId;
    name: string;
    /** The folders the area names, as the app's Access page lists them. */
    folders: readonly string[];
}

export interface AccessPersona {
    id: AccessPersonaId;
    name: string;
    role: string;
    /** The area it is homed in: whoever holds that area may pick it. */
    home: AccessAreaId;
    /** The connections its turns may act through, by the daemon's `personaAllowsCapability`. */
    allows: readonly AccessOutwardId[];
    /** One sentence for the caption when it is pointed at. */
    note: string;
}

export interface AccessOutward {
    id: AccessOutwardId;
    label: string;
    /** A second, quieter name: which account, which system, what it serves. */
    detail?: string;
    /** A model's provider mark, drawn from `PROVIDER_BRAND_PATHS`. */
    mark?: "claude" | "codex";
}

export interface AccessGroup {
    key: AccessGroupKey;
    label: string;
    items: readonly AccessOutward[];
}

export interface AccessPrincipal {
    id: string;
    cluster: AccessClusterKey;
    name: string;
    /** What it may do, in the app's words for its tier or scope. */
    line: string;
    /** What the caption says while it is lit: a short claim, then why. */
    title: string;
    body: string;
    /** For a person: the hue of their face, as the app gives each address its own. */
    hue?: number;
    /** The persona it acts as, named on a room it reaches only that way. */
    actsAs?: AccessPersonaId;
    reach: Readonly<Partial<Record<AccessNodeId, AccessHow>>>;
}

export interface AccessMapScene {
    eyebrow: string;
    heading: string;
    sub: string;
    cta: { label: string; href: string };
    /** Under the figure: that the sandbox is a sample, and where the reader's own is drawn. */
    footnote: string;
    /** The sandbox's name on the drawing. */
    sandbox: string;
    columns: { in: string; out: string };
    clusters: Readonly<Record<AccessClusterKey, string>>;
    areas: readonly AccessArea[];
    personas: readonly AccessPersona[];
    /** `called` is the secrets' name inside a sentence: "Who reaches the secrets". */
    secrets: { label: string; called: string; names: readonly string[]; note: string };
    groups: readonly AccessGroup[];
    principals: readonly AccessPrincipal[];
    /** What the caption says before anything is pointed at. */
    intro: { title: string; body: string };
    /** The caption's words for a thing pointed at: who reaches it, sorted by how. */
    reachedBy: { title: string; nobody: string; how: Readonly<Record<AccessHow, string>>; persona: string };
    /** The small word a lit room or chip wears, by how it is reached. */
    tags: Readonly<Record<AccessHow, string>>;
    legend: { direct: string; through: string };
    tour: { pause: string; play: string };
    /** Spoken equivalent of the whole figure, for a reader who never sees it. */
    label: string;
}

const EVERY_AREA = { "area:support": "edit", "area:storefront": "edit", rest: "edit" } as const;
const EVERY_OUTWARD = (how: AccessHow) =>
    ({
        "cap:github": how,
        "cap:stripe": how,
        "cap:sentry": how,
        "cap:zendesk": how,
        "cap:posthog": how,
        "cap:gmail": how,
        "cap:x": how,
        "cap:office-pc": how,
        "cap:ops-box": how,
        "cap:release-box": how,
        "port:3000": how,
        outbox: how,
        "model:claude": how,
        "model:codex": how,
    }) satisfies Record<AccessOutwardId, AccessHow>;
// Anyone whose turns run reaches the models they run on and can put something in front of the internet.
const EVERY_TURN = (how: AccessHow) => ({ "port:3000": how, outbox: how, "model:claude": how, "model:codex": how }) as const;

export const accessMapScene: AccessMapScene = {
    eyebrow: "Who reaches what",
    heading: "Share the agents, not the keys.",
    sub: "Invite a teammate, a client or a CI job. Each one gets in through its own door and reaches only what its grant allows. The daemon checks every line you see here.",
    cta: { label: "How access works", href: "/docs/access/" },
    footnote: "The sandbox above is a sample. The app draws the same map of your own sandbox, under Sandbox ▸ Map.",
    sandbox: "acme-shop",
    columns: { in: "Who gets in", out: "What it reaches" },
    clusters: { people: "People", programs: "Control tokens", sandboxes: "Linked sandboxes" },
    areas: [
        { id: "area:support", name: "Support desk", folders: ["support/", "docs/help/"] },
        { id: "area:storefront", name: "Storefront", folders: ["web/"] },
        { id: "rest", name: "Rest of the workspace", folders: ["api/", "ops/", ".github/"] },
    ],
    personas: [
        {
            id: "persona:maya",
            name: "Maya",
            role: "Customer Care",
            home: "area:support",
            allows: ["cap:zendesk", "cap:stripe", "cap:gmail"],
            note: "Lives in Support desk. Her turns may use Zendesk, Stripe and the support inbox, and nothing else.",
        },
        {
            id: "persona:owen",
            name: "Owen",
            role: "Growth",
            home: "area:storefront",
            allows: ["cap:posthog", "cap:x"],
            note: "Lives in Storefront. His turns may use PostHog and the shop's X account, and nothing else.",
        },
    ],
    secrets: {
        label: "Secrets",
        called: "the secrets",
        names: ["DATABASE_URL", "SENTRY_DSN", "SESSION_SECRET"],
        note: "Injected into a turn that may hold them, never written to disk.",
    },
    groups: [
        {
            key: "services",
            label: "Services",
            items: [
                { id: "cap:github", label: "GitHub" },
                { id: "cap:stripe", label: "Stripe" },
                { id: "cap:sentry", label: "Sentry" },
                { id: "cap:zendesk", label: "Zendesk" },
                { id: "cap:posthog", label: "PostHog" },
            ],
        },
        {
            key: "accounts",
            label: "Accounts and browsers",
            items: [
                { id: "cap:gmail", label: "Gmail", detail: "support inbox" },
                { id: "cap:x", label: "X", detail: "@acmeshop" },
            ],
        },
        {
            key: "machines",
            label: "Machines",
            items: [
                { id: "cap:office-pc", label: "office-pc", detail: "Windows" },
                { id: "cap:ops-box", label: "ops-box", detail: "SSH" },
            ],
        },
        { key: "sandboxes", label: "Other sandboxes", items: [{ id: "cap:release-box", label: "release-box" }] },
        {
            key: "network",
            label: "Network and public",
            items: [
                { id: "port:3000", label: "Port 3000", detail: "shop preview" },
                { id: "outbox", label: "Public outbox", detail: "4 files" },
            ],
        },
        {
            key: "models",
            label: "Models",
            items: [
                { id: "model:claude", label: "Claude", mark: "claude" },
                { id: "model:codex", label: "Codex", mark: "codex" },
            ],
        },
    ],
    principals: [
        {
            id: "you",
            cluster: "people",
            name: "You",
            line: "Owns it",
            hue: 32,
            title: "You own acme-shop.",
            body: "Every folder, every persona, every key. Ownership is bound at your first sign-in and can never be granted to anyone else.",
            reach: { ...EVERY_AREA, "persona:maya": "use", "persona:owen": "use", secrets: "use", ...EVERY_OUTWARD("use") },
        },
        {
            id: "ada",
            cluster: "people",
            name: "Ada",
            line: "Edits Support desk",
            hue: 200,
            title: "Ada changes files only in Support desk.",
            body: "She is a writer on one area. Her agents carry just the three keys her grant lists, so Stripe, the machines and every secret stay out of her reach.",
            // A writer: edits where she sees, wears the personas homed there, and her credential reach names three.
            reach: {
                "area:support": "edit",
                "persona:maya": "use",
                "cap:github": "use",
                "cap:zendesk": "use",
                "cap:gmail": "use",
                ...EVERY_TURN("use"),
            },
        },
        {
            id: "kai",
            cluster: "people",
            name: "Kai",
            line: "Chats as Maya",
            hue: 145,
            actsAs: "persona:maya",
            title: "Kai talks to Maya, and only to Maya.",
            body: "A guest sees no files and no other conversations. Kai can reach only what Maya's turns may use, and the owner kept the secrets back.",
            // A guest on Support desk: acts only through the persona homed there, with the secrets left out of the grant.
            reach: {
                "area:support": "through",
                "persona:maya": "use",
                "cap:zendesk": "through",
                "cap:stripe": "through",
                "cap:gmail": "through",
                ...EVERY_TURN("through"),
            },
        },
        {
            id: "nightly-ci",
            cluster: "programs",
            name: "nightly CI",
            line: "Drives agents",
            title: "nightly CI starts agents and edits nothing by hand.",
            body: "A control token carries no identity, so its scope is its whole limit. This one starts and steers turns, and cannot land their work.",
            reach: {
                "area:support": "see",
                "area:storefront": "see",
                rest: "see",
                "persona:maya": "use",
                "persona:owen": "use",
                secrets: "use",
                ...EVERY_OUTWARD("use"),
            },
        },
        {
            id: "status-board",
            cluster: "programs",
            name: "status board",
            line: "Reads",
            title: "status board watches and starts nothing.",
            body: "A read token sees the whole workspace and runs no turn, so nothing outside the box is ever reached on its behalf.",
            reach: { "area:support": "see", "area:storefront": "see", rest: "see" },
        },
        {
            id: "helpdesk",
            cluster: "sandboxes",
            name: "helpdesk",
            line: "Runs tasks as Maya",
            actsAs: "persona:maya",
            title: "helpdesk hands its tasks over, and they run as Maya.",
            body: "Another sandbox, linked to this one. Its tasks work inside Maya's folders, through Maya's connections, and change no file by hand.",
            // A link pinned to a persona: that persona's folders, its connections, read-only by hand.
            reach: {
                "area:support": "see",
                "persona:maya": "use",
                secrets: "through",
                "cap:zendesk": "through",
                "cap:stripe": "through",
                "cap:gmail": "through",
                ...EVERY_TURN("through"),
            },
        },
    ],
    intro: {
        title: "Point at anyone to light what they reach.",
        body: "Point at anything to see who reaches it. Click to keep it lit.",
    },
    reachedBy: {
        title: "Who reaches {name}",
        nobody: "Nothing that gets in reaches it.",
        how: { edit: "Changes it", see: "Only reads it", use: "Uses it", through: "Only as a persona" },
        // A persona is worn rather than used: its caption names who may work as it.
        persona: "Works as {name}",
    },
    tags: { edit: "edits", see: "reads", use: "uses", through: "as a persona" },
    legend: { direct: "Acts directly", through: "Only through a persona" },
    tour: { pause: "Pause the tour", play: "Play the tour" },
    label: "A map of one sandbox, acme-shop. On the left, who gets in: you, Ada, Kai, two control tokens and a linked sandbox. In the middle, the sandbox: its areas Support desk, Storefront and the rest of the workspace, the personas Maya and Owen homed in them, and its secrets. On the right, what it reaches: services, accounts, machines, another sandbox, what it publishes and the models it runs on. Each way in reaches only part of it.",
};
