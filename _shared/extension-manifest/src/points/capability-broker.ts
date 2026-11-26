import { z } from "zod";

// A cli card's credential gateway declaration (`broker`): its routes, the method and path rules its credential is held
// to, and the outward actions its requests perform. Split from capabilities.ts, which holds the card shapes it rides on.

// How a cli card's credential reaches the services it is for without ever reaching the agent: the sandbox's credential
// gateway, a loopback-only listener the agent's shell calls instead of the service. The gateway picks the upstream from
// this declaration (never from the request), attaches the credential the way the service takes it, checks the card's
// rules and gates, and forwards. The agent's env holds the gateway's address and, where a tool insists on a token
// variable, an inert placeholder.
const BrokerRouteSchema = z.object({
    upstream: z
        .string()
        .min(1)
        .describe(
            "The service's base URL, a template over the fields like `env` (`https://api.github.com`, `${url}`). What is sent to this route's gateway address goes here and nowhere else.",
        ),
    env: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional()
        .describe(
            "The variable the agent's shell finds this route's gateway address in (`GITHUB_API_URL`), suffixed per instance like `env`. Naming one of `env`'s own variables (`GITLAB_URL`) points it at the gateway instead of the service, so a skill written against it needs no change.",
        ),
    headers: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            'The headers that carry the credential, templated over the fields (`{"authorization": "Bearer ${token}"}`). The gateway sets them on every request it forwards, replacing any the agent sent under the same name.',
        ),
    basic: z
        .object({ username: z.string(), password: z.string() })
        .optional()
        .describe(
            "HTTP Basic credentials, templated over the fields, for a service that takes them (git over HTTPS: `x-access-token` and `${token}`).",
        ),
    form: z
        .record(z.string(), z.string())
        .optional()
        .describe(
            "Fields the gateway sets in a request's url-encoded form body, templated over the fields, for a service that takes its credential there: an OAuth token exchange's `client_secret` or `refresh_token`. What the exchange answers (a short-lived access token) is the agent's to use; the long-lived secret never is.",
        ),
    pathPrefix: z
        .string()
        .startsWith("/")
        .optional()
        .describe(
            "A path the gateway puts before the agent's own, templated over the fields, for a service that takes its credential in the path (Telegram's `/bot${token}`).",
        ),
    git: z
        .boolean()
        .optional()
        .describe(
            "This upstream serves git over HTTP: the agent's git is pointed at the gateway for it (`url.<gateway>.insteadOf`), so a clone, fetch or push needs no credential in the agent's hands.",
        ),
});
export type BrokerRoute = z.infer<typeof BrokerRouteSchema>;

export const BrokerRuleSchema = z.object({
    methods: z
        .array(z.string().regex(/^[A-Z]+$/))
        .optional()
        .describe("The HTTP methods it covers (`DELETE`, `PUT`); absent covers every method."),
    paths: z
        .array(z.string().startsWith("/"))
        .optional()
        .describe(
            "The paths it covers, below the route's upstream: `*` matches one segment, `**` any number of them (`/repos/*/*/hooks/**`). Absent covers every path.",
        ),
    action: z.enum(["allow", "ask", "deny"]).describe("`allow` forwards it, `ask` holds it on a card for the owner, `deny` refuses it."),
    why: z.string().optional().describe("One line on what the rule protects, shown on the card or in the refusal."),
});
export type BrokerRule = z.infer<typeof BrokerRuleSchema>;

// An outward action's key below its card's id (`message.send`). The sandbox names it `<card id>.<action>`
// (`slack.message.send`): the key the owner's action rules are written under and the Guardrails page offers.
export const OUTWARD_ACTION_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const OutwardActionKeySchema = z
    .string()
    .regex(OUTWARD_ACTION_KEY)
    .describe(
        "The action's key below the card's id (`message.send`, `reaction.add`): the sandbox names it `<card id>.<action>`, which is the key the owner's action rules (Guardrails) are written under.",
    );

const ReadsOnlySchema = z
    .boolean()
    .optional()
    .describe(
        "This action only reads. It is recorded and held to a rule written for it like any other, but Guardrails does not offer it: a rule there would hold the bot reading its own channel.",
    );

// Where one request names what it acts on: a field of its query or body, or the path segment after a fixed one.
const RequestValueSchema = z.union([
    z.object({
        field: z
            .string()
            .min(1)
            .describe("A top-level field of the request's JSON, url-encoded or multipart body, else of its query (`channel`, `chat_id`)."),
    }),
    z.object({
        after: z.string().min(1).describe("The path segment that follows this one (`channels` reads `123` from `/channels/123/messages`)."),
    }),
]);

// One outward action a brokered card's requests perform, recognised by the gateway on the request itself: the gateway
// classifies, records and gates it, so the sandbox needs to know no provider by name.
export const BrokerActionSchema = z.object({
    action: OutwardActionKeySchema,
    methods: z
        .array(z.string().regex(/^[A-Z]+$/))
        .optional()
        .describe("The HTTP methods that perform it; absent is every method."),
    paths: z
        .array(z.string().startsWith("/"))
        .optional()
        .describe(
            "The paths that perform it, below the route's upstream, in the rules' globs: `*` one segment, `**` any number (`/channels/*/messages`). Absent is every path.",
        ),
    read: ReadsOnlySchema,
    channel: RequestValueSchema.optional().describe("Where the request names the channel, chat or recipient it acts on, for its Activity row."),
    content: z
        .object({ field: z.string().min(1).describe("A top-level field of the request's body (`text`, `content`).") })
        .optional()
        .describe(
            "Where the request carries what it says, for its Activity row. A JSON body without that field is recorded whole; a file upload never is.",
        ),
});
export type BrokerAction = z.infer<typeof BrokerActionSchema>;

// Which of a command's arguments carries a value, counted from 0 after the command's own words.
const CommandValueSchema = z.object({
    arg: z.number().int().nonnegative().describe("The argument's position after the command's own words, counted from 0."),
    rest: z.boolean().optional().describe("Take every argument from there on, joined by spaces (a message typed unquoted)."),
});

// One outward action a command-line tool of the extension performs for this card, recognised in the commands an agent
// runs: the command guard holds it to the owner's action rules before it runs, and the turn records it once it ends.
export const CommandActionSchema = z.object({
    action: OutwardActionKeySchema,
    command: z
        .array(z.string().regex(/^\S+$/))
        .min(1)
        .describe("The program and the words that select the command (`[\"whatsapp\", \"send\"]`), matched at the start of an invocation."),
    read: ReadsOnlySchema,
    channel: CommandValueSchema.omit({ rest: true }).optional().describe("The argument naming the chat or recipient, for its Activity row."),
    content: CommandValueSchema.optional().describe("The argument carrying what it says, for its Activity row."),
    // (2026-11-26, extension API 2.52.0) Who decides the rule, said outright. Until then a backend-gated sender declared
    // `selfGated`, which also made it hold while no rule named it, so one flag carried two answers.
    gatedBy: z
        .enum(["sandbox", "backend"])
        .optional()
        .describe(
            "Who holds the command to the owner's action rule. `sandbox` (the default): the command guard refuses a command the rule denies or holds before it runs, and the turn records it in Activity once it ends. `backend`: the card's own backend carries the action out and asks the sandbox's outward-action door first (`POST /capabilities/{id}/outward-action`), which decides, records it in Activity and turns a hold into an approvals item the backend performs once a person says yes; the command guard lets the command run, so a held send reaches the door that drafts its approval.",
        ),
    unruled: z
        .enum(["allow", "hold"])
        .optional()
        .describe(
            "What the action comes to while no action rule names it. `allow` (the default) lets it go. `hold` waits for the owner's yes until a rule says otherwise: the command guard refuses it with the way to draft an approval, or, for `gatedBy: \"backend\"`, the outward-action door drafts it. Guardrails shows it as the action's default. Declarations of one action that differ hold it if any says `hold`.",
        ),
    selfGated: z
        .boolean()
        .optional()
        .describe(
            'Deprecated since 2.52.0: declare `gatedBy: "backend"` and `unruled: "hold"`, which is how `true` is still read (an `unruled` beside it wins).',
        ),
});
export type CommandAction = z.infer<typeof CommandActionSchema>;

// Who decides a command action's rule and what it comes to while none names it, the deprecated `selfGated` read as the two
// it stood for: a backend's door, holding while unruled.
export interface CommandActionGate {
    readonly gatedBy: "sandbox" | "backend";
    readonly unruled: "allow" | "hold";
}

export const commandActionGate = (entry: Pick<CommandAction, "gatedBy" | "unruled" | "selfGated">): CommandActionGate => {
    const legacy = entry.selfGated === true;
    return { gatedBy: entry.gatedBy ?? (legacy ? "backend" : "sandbox"), unruled: entry.unruled ?? (legacy ? "hold" : "allow") };
};

/** Whether an action waits for the owner's yes while no rule names it: one of its declarations says `hold`. */
export const holdsUnruled = (entries: readonly Pick<CommandAction, "gatedBy" | "unruled" | "selfGated">[]): boolean =>
    entries.some((entry) => commandActionGate(entry).unruled === "hold");

export const BrokerSchema = z.object({
    routes: z.array(BrokerRouteSchema).min(1),
    rules: z
        .array(BrokerRuleSchema)
        .optional()
        .describe(
            "What the credential may do, checked in order against each request the gateway forwards; the first rule covering a request decides, and one no rule covers is allowed. The owner's own rules for a card replace these.",
        ),
    // (2026-11-25) Declared here rather than matched in the daemon by a provider's address: the chat skills reach their
    // services through the gateway's variables, which no address pattern sees.
    actions: z
        .array(BrokerActionSchema)
        .optional()
        .describe(
            "The outward actions this card's requests perform (send, edit, react), checked in order against each request the gateway sees; the first that covers it names it. The gateway records each request of a card that declares any in Activity (one no action covers as `api.call`) and holds it to the owner's action rules for `<card id>.<action>`.",
        ),
});
export type Broker = z.infer<typeof BrokerSchema>;
