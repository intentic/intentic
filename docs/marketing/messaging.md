# intentic: Messaging

What we say, in which words, everywhere. Pairs with [positioning.md](positioning.md) (personas +
pains, P1–P7) and [landing-blueprint.md](landing-blueprint.md) (section placement). The product
being sold is **intentic-app** (app.intentic.dev): **a machine of their own for your agents**:
co-piloted agents living in **sandboxes**, still running when you look away,
reached from any browser. The sandbox and CLI that run on your machine are MIT open source on
GitHub: the trust layer you can read and run yourself.

> **One word for the thing.** The object is always a **sandbox**: that is what the app's own tab,
> the API, the packages and the docs call it, without exception. No synonym is licensed anywhere,
> including in the brand line, which names the **actor** ("agents", the app's own word for it) and
> never the machine. The host machine is a "laptop, desktop or VPS", never a second word for the
> sandbox. See the glossary below.

## Rules of voice

- Engineer-to-engineer. Declarative sentences. Second person for the reader; "intentic" always lowercase.
- Evidence over adjectives: no claim a screenshot, code block, or repo link can't back.
  Banned words: effortless, blazingly, seamless, magic, revolutionize, supercharge.
- **Shortest version that still lands.** A visitor skims; every extra clause is a chance to leave. One
  idea per sentence, one sentence per point, and no second paragraph doing the first one's job again.
  A hero subhead is under fifteen words, a card line under twenty, an FAQ answer one paragraph. If a
  sentence survives being cut in half, it was too long.
- **No em-dashes in copy.** They signal an aside the reader has to hold open, which is exactly the
  cost brevity is trying to remove. Use a full stop where the thought ends, a colon where a list or
  explanation follows, a semicolon where two clauses genuinely balance, or parentheses for a true
  aside. This applies to everything a visitor reads, on the site and in the app; source comments are
  their own business.
- **Ownership is an answer, not an opener.** "Your machine" removes a fear, it does not create
  a want, so it never buys headline or subhead space. It earns its keep in the hero chip, the
  economics band, the trust band, the comparison pages, `/features/host/` and the FAQ, where somebody
  is already asking. It no longer gets a band of its own on the landing page (retired 2026-08-15, see
  landing-blueprint.md): the trust band's first card was already making the whole argument.
- **No sentence may lean on a word the reader has not been given.** A pronoun needs its noun on the
  same screen, and a noun the product invented needs defining where it first appears. This is the rule
  the page kept breaking: "Run them, wire them to your systems" under a heading whose only noun was
  "a fleet", "It plans first" with no *it* in sight, "sandbox" used four bands before it was explained.
  A visitor who arrives mid-page, or who does not already live in this category, is the reader every
  line is checked against.
- The product already wrote its best lines: reuse in-app copy verbatim before writing new copy.
  The app and the site must sound like one author.
- Ownership language is the spine: "your machine", "your accounts", "you own every line",
  "stays inside your sandbox". Never "we host your code": we don't.
- Provider-agnostic: intentic works with Claude Code, Codex, Grok, and whatever ships next. Name
  providers as plural examples for credibility, never as the headline or the brand hook: the
  subject is always the **specialized agent** (the autonomous employee), never one provider.
- Honesty is a feature: that it is free and MIT is stated plainly; the app is new and says so.
- **Hide setup complexity, expose operational state.** The machinery that makes the sandbox
  reachable (the tunnel, Docker, daemon auth) is sold as its absence ("one command", "no ports to
  open", "a private tunnel"), never explained or itemized. What the copy shows off is the state of
  the runs: the board, who needs you, what each agent changed and spent, the diff. Plumbing is a
  cost the reader shouldn't feel; state is the product.

## Message hierarchy

**The one thing the page sells:** **your agents get a machine of their own: every browser is a window onto it.** The agents live on your machine, not in a tab:
close the laptop and the runs keep going; open any browser (or a phone) and the same fleet is
there, sorted by who needs you. What that machine is built for are **co-piloted specialized
agents**: autonomous employees, each a purpose-built sandbox, running on your
own Claude/Codex/Grok subscription. Run one, or ten in parallel.

**The golden path is the story spine**, and every band ladders onto one of its steps: connect a
machine with one command → give the work to agents, each in its own git worktree → walk
away, the runs continue → reopen from any browser or phone onto the same runs → steer, answer,
interrupt → review every change before it is merged.

The claim is literal, not a metaphor, and that is what makes it defensible: the sandbox is a real
daemon on the user's machine and the browser holds nothing a run depends on: closing every window
loses nothing. The shared-surfaces construction is the supporting mechanism: you and the agent drive
the *same* surfaces (one `tmux` server behind your terminals and its shell commands; one `iq` index
behind `/workspace/search` and its Bash calls; one tree, where each agent works on its own git
worktree and lands its delta into your Changes panel for review), so a window opened anywhere shows
the run as it actually is, not a replay of it.

An autonomous agent is not fire-and-forget. AI still needs (a) its context configured, (b) its work
supervised, and (c) a human in the loop for the decisions that matter. So every agent is
**co-piloted**: and that is exactly why intentic is a full workspace, not a chat box. Two families
of surfaces earn the "workspace" claim, and every band on the page ladders up to one of them:

- **IDE**, editor, file tree, diff review, terminal: the surfaces that let you *configure* an agent
  and read its work.
- **observability**: the fleet board, plan mode, per-edit permission modes, changes review,
  transcripts: the surfaces that let you *watch and steer* the agents you run.

**Ownership** is the trust foundation under both (agent on your machine, platform off the
command path, code and keys never leave your machine). **Automations** make agents event-driven, and
a whole team of them costs nothing extra; the **economics** are BYO subscription + self-hosted
+ a product that is free and MIT: never a meter on model usage.

Landing copy lives in code: `_site/site-content/src/landing.ts` is a single `LandingContent` object
- **one page, no variants** (there is no `SITE_VARIANT`, no `/preview` route, no a/b/c doors).
Change copy there, not in the `.astro` files.

**Hero CTA:** `Get started free` → app.intentic.dev. Secondary: `See the source` → the GitHub repo
(github.com/intentic/intentic): the trust-through-transparency path.

Retired framing (do not bring back): "Your coding agent. Out of the terminal.", "Build software with
intent." as the definition, "An AI-native workspace for infra, data, apps, and code…", "Specialized
agents that own their workspace", **"A specialized agent is more than a prompt."** as the
headline: it argued against a strawman nobody's pain matches, restated the contrast band 1500px
early, and filed us with prompt-builders instead of Cursor/Codespaces/Devin, **"The IDE you
share with your agents."** / "A shared IDE for you and your agents" as the tagline,
**"An IDE for your agents."** as the tagline's first line (retired 2026-08-07): "IDE" named the
surfaces instead of the capability: it filed us with editors, and nothing in it said the run
survives you leaving, which is the one thing the infrastructure buys that a reader can picture: and
**"Workstation for your agents. A window for you."** as the tagline (retired 2026-08-12): both nouns
charged the reader a translation. "Workstation" reads as a desktop PC, so the claim landed one hop
late, and it needed a standing glossary rule to stop the word leaking into copy that means the
sandbox; "a window for you" cast the buyer as a spectator, which is the opposite of a co-piloted
product where the human approves the plan and reads every diff. "window" survives as glossary
vocabulary for any signed-in browser, but it is no longer a brand noun.
"specialized agent" survives as *mechanism* vocabulary (see the glossary); it is no longer the
headline claim. **"You delegate. They work. You approve."** is retired as the brand line (2026-08-15):
the pronoun named nothing in the system on purpose, and paid for that by having no antecedent
anywhere above the fold. Strangers read the whole page and still could not say what the product was,
and the model they built instead came off the loudest words on the page (Extensions, Earn,
registries): "a place to share snippets that LLM agents use". A stance needs a subject the reader
already holds.

The brand tagline is now "You delegate. Agents work. You approve."
(org metadata, `_site/site-content/src/site.ts`), rendered as the hero
`You delegate. Agents work. / You approve.`: three beats split 2 + 1, so the line that stands alone
is the one the reader has to believe. It states the working stance in words nobody has to translate,
and the single word it takes from the system is the app's own name for the actor, so it teaches a
word the product answers to. It still licenses no second noun for the machine.

**The hero subhead carries the category**: `A workspace for coding agents. Nothing happens out of
sight.` Ownership is not the only thing kept out of the first screen by the rules above: any
statement of what the product *is* was out too, and that is not a differentiator to be earned later,
it is the sentence every other claim hangs on. So the category noun leads and the visibility claim
(recorded 2026-08-12) follows unchanged as the second beat. Same order for the page title and the
meta description: category first, differentiators after.

## Section order

The page is a single continuous scroll; the full section-by-section blueprint (ids, jobs, accuracy
rules) lives in [landing-blueprint.md](landing-blueprint.md). At the message level the order walks
the golden path: **state the claim** (Hero) → **show what you do** (the five verbs, orchestrate the
fleet, empower it, automate it, supervise it, delegate it: each one line and one screen, linking to
its page) → **carry the trust** (ownership) → **the deal** (economics) → **who is behind it** (trust)
→ **get connected** → **objections** (FAQ) → **final CTA**. Each pain from positioning.md (P1–P7)
surfaces where its band lands.

**Free, no pricing section (principle, not a section).** There is deliberately no on-page pricing
block and no "Pricing" nav/footer link: there is nothing to price. The whole product is free and
MIT, and the page says so softly rather than loudly: the hero "Free and open source" chip, the
economics band, the final CTA, and the FAQ answer "Is any of it paid?". Do not introduce a pricing
section.

## Glossary (use these words, exactly)

- **sandbox**, the machine side of the product, and **the only noun for it**: the Docker container on
  the user's machine that holds the workspace, runs the agents, and keeps going when every browser
  is closed. This is the word the app's tab, the API routes, the npm packages and the docs all use, so
  copy that disagrees with it teaches the reader a word the product will not answer to. Never
  "server", never "cloud", never "instance", never "workstation": the word has to keep saying *a real
  machine of yours*. One host can run several; a user switches between them by name.
- **window**, any signed-in browser on any device: a view onto the same running sandbox, holding
  nothing a run depends on. Close it, open another anywhere, nothing is lost. Body vocabulary, not a
  brand noun; "the window" in copy always means this, never a desktop app window.
- **specialized agent** (a.k.a. **autonomous employee**): a coding agent given its own sandbox for
  one job: dev-tools really installed, wired to your systems, context curated for that role. A
  *mechanism* word (what a sandbox is *for*) never the headline claim. Careful with the level: a
  specialized agent is one sandbox, while the parallel conversations inside it each get a **git
  worktree**, not a sandbox of their own. "Each agent gets its own sandbox and worktree" conflates
  the two and is the most common slip in this glossary.
- **the environment**, the sum of the layers a prompt can't reach: the image the tools are installed
  in, the capabilities the agent may use, the context it loads each turn. The deep differentiator
  under the ownership claim: all of it is **visible and editable**, not merely existent.
- **co-piloted**, the working stance: the agent runs autonomously, but you configure its context,
  supervise its work, and stay in the loop for the decisions that matter. Never "fire-and-forget",
  never "fully autonomous" without this qualifier.
- **workspace**, what the user experiences in the browser: chat + files + editor + diff review +
  terminal (the **IDE** surfaces) over a sandbox, plus the **observability** surfaces that watch and
  steer it. The reason it's a workspace and not a chat box.
- **fleet board**, the /agents home surface: every running agent as a parallel, isolated
  conversation: the coworking-space view of your workforce.
- **sandbox**: the per-agent daemon running on the user's machine, reached over its own private
  tunnel. Never "VM", "container instance", or "environment".
- **capability**: an installable power that wires the sandbox to your systems (GitHub, a SQL
  database, Discord, Stripe, SSH, an MCP server…). Never "integration" or "plugin" (plugins are a
  specific capability).
- **automation**: a rule that wakes the agent (schedule / event / listen), optionally gated by a
  **guard command**. Never "cron job" or "workflow".
- **plan mode**: the permission mode where the agent proposes and waits for approval; the default
  for a chat on the shared workspace tree, one click away everywhere else. An agent working in its
  own branch defaults to **auto** (it owns that worktree; its output is reviewed as a diff, not
  approved command by command). Also: accept edits / ask before edits.
- **desktop sync**: two-way near-real-time folder sync between the user's editor and the sandbox.
- **agent**: the coding agent working inside the sandbox (Claude Code, Codex, Grok, …). Name
  providers as examples; never "our AI", never one provider as the brand.
- **Deployment is not a landing element.** The monorepo happens to include a deployment engine, but
  it is just one of the many tools an agent can run (like `psql`, a headless browser, or `docker`):
  never a pillar, section, "superpower", card, or FAQ headline. Its vocabulary (intent,
  `i.have`/`i.want`, derive, reconcile, desired state) belongs to the engine's own docs and never
  appears in landing or FAQ copy. If deployment comes up at all, it is one unremarkable example of a
  tool an agent can run, nothing more.

## Objection bank (FAQ source of truth)

1. **Where does my code live?**: On your machine. The sandbox runs where you start it; your
   browser reaches it over a private Cloudflare tunnel. The platform stores your identity and the
   sandbox's URL: it never relays your files or sits between you and your sandbox.
2. **What happens when I close the browser?**: Nothing, to the runs. The agents live on your
   machine, not in the tab; the browser is a window. Terminals survive the disconnect, turns finish
   without you, and reopening from any device (including a phone) lands you on the same fleet,
   sorted by who now needs you.
3. **Can intentic read my secrets?**: No. Credentials live inside your sandbox; the platform has
   no path to them. What little the platform does store (OAuth tokens, connect tokens) is
   AES-256-GCM encrypted with no decrypt path in the product. Secret files are denylisted from the
   workspace file relay.
4. **Which AI models does it use?**, Your choice per conversation: Claude Code (Opus, Sonnet,
   Haiku), Codex, or Grok, with adjustable reasoning effort. Your provider, your account, your usage.
5. **Do I need a Cloudflare account?**: No. By default intentic provisions the tunnel under its
   own domain. Bring your own zone if you prefer: your token is used once to list zones and is
   never stored.
6. **What do I need to run a sandbox?**: A machine with Docker (installed automatically if
   missing, with your confirmation) and a Google account. No open inbound ports, nothing deployed.
7. **Can the agent break my stuff?**: No, because it's co-piloted, not fire-and-forget. It starts
   in plan mode: it proposes, you approve. Every file change is reviewable as a diff you can discard
   or commit; environment (Dockerfile) changes require your explicit approval; stricter and looser
   modes are one click away.
8. **Is any of it paid?**: No. Every sandbox, every capability, the agent, automations and team
   sharing are free, with no tiers and no card. The whole product is MIT on GitHub. You pay only
   your own model provider, directly.
9. **What are automations?**, Scheduled or event-driven agent wake-ups: GitHub/GitLab pushes,
   Sentry alerts, Stripe payments, new email, Discord messages, or plain cron: each run a fresh
   agent session with a transcript, optionally gated by a guard command you define.
10. **Is it open source? Can I run it without the app?**: Yes. The sandbox and CLI that execute on
   your machine are MIT on GitHub (github.com/intentic/intentic): read exactly what runs on your
   hardware, and drive a sandbox from the CLI without ever signing in. The hosted app adds the
   browser workspace, the fleet board, capabilities, automations, and teams.
11. **What about my data (export, deletion?**) Settings → Export downloads everything the
    platform stores about your account as JSON (deliberately excluding credentials). Account
    deletion cascades sandboxes, sessions, and grants.
12. **Is it production-ready?**: The app is new and says so. Because the sandbox and CLI are MIT on
    GitHub, you can read exactly what runs on your machine before you trust it with anything you
    care about: and because the agent is co-piloted (plan mode, reviewable diffs, owner-approved
    environment changes), you stay in control of every change. Verify test counts and prices at
    build time: never hardcode stale numbers.
13. **How does this compare to Conductor, Cursor, OpenCode or Nimbalyst?**: For most of that list it
    doesn't compete. Claude Code, Codex and OpenCode are agent harnesses and intentic runs all of
    them; any ACP agent is one capability away. Cursor and the other AI editors put you at the
    keyboard while intentic puts the agent there, and desktop sync mirrors the sandbox into a folder
    your own editor opens. The real comparison is with local orchestrators (Conductor, Nimbalyst),
    which share the ownership stance and differ on scope; the one genuine either/or is a cloud agent
    platform. The long answer is the comparison shelf: see positioning.md's competitive frame for
    the four families and the rules that keep those pages honest.

## SEO strings

- The landing is a single page: its title/description are **not** per-variant; they live in
  `_site/site-content/src/landing.ts` (`meta`). Title:
  `intentic · A workspace for coding agents`: the category, not the brand line. A search result, a
  browser tab and a pasted link are the three places a stranger meets this product with no page
  around it to explain it, so all three say what it is.
- Org description (`_site/site-content/src/site.ts`, JSON-LD): the canonical product sentence; keep
  the site and these docs in sync with it verbatim: `A workspace for coding agents. You delegate.
  Agents work. You approve. Each one works in a sandbox, in its own git worktree.
  It keeps running when you close the browser. Reopen from any device, steer the same fleet, and read
  every diff before it lands. Free.`
- Keywords to carry naturally: the title now carries the category phrase and the tagline carries
  "agents"; the rest are earned by body copy, which says "sandbox": persistent coding
  agent, self-hosted AI agent,
  run agents self-hosted, control agents from anywhere, remote agent control, coding
  agent, agent sandbox, specialized agent, autonomous agent, AI employee, agent workforce, Claude
  Code, Codex, Grok, AI IDE, Devin alternative, own your code.
- The **`intentic vs X` / `X alternative`** queries are served by the comparison shelf (`/compare/`),
  one URL per competitor: that is the whole reason it isn't a single page with anchors. Each page
  owns its own title, description, OG card and breadcrumb; the hub owns the category query. Adding a
  competitor is an entry in `comparePages` and the nav row, footer link, page meta, OG card, sitemap
  entry and llms.txt line all follow from it.
