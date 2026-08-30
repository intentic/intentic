# Setup view: why it loses people, and what to change

A UX analysis of `/setup`, the first screen every new account sees. Based on walking the
live page on 2026-08-20 as a signed-in account, at desktop width (1280) and phone width
(390), plus a read of the page source (`_editor/web/src/pages/Setup.vue` and its
satellites). Two constraints from the owner shape every recommendation: do not funnel
everyone into the hosted lane, and do not split the page into wizard steps.

## What a new visitor sees

Desktop, first paint, default state:

- Header: "Set up your workspace. Pick where it runs. You'll be working in it in a
  minute or two."
- A card of facts: Name `workspace` with a pencil, Address
  `sandbox-fa0b431303b8.sbx.intentic.dev`, and a link "Use a different address". For
  anyone who bounced once before, the card's first sentence is "Made last time you were
  here, never started. Use a new sandbox instead."
- A three-card picker: "We host it, Free · 40h a month, then membership",
  "A computer I own: Most power · no limits" (preselected), "A cloud machine I own:
  From free · 12 GB".
- The consequence of the preselected card:
  `curl -fsSL https://intentic.dev/connect | sudo env SYNC_DIR='…' sh -s -- --vphf_-3wk`
  behind three tabs (Linux / macOS, Windows (PowerShell), Docker Compose), a checkbox
  reading "I already have Docker, sudo is there for one job: installing Docker if it's
  missing", and a spinner: "Waiting for you to run the command."
- A right rail: "What this does, Starts your sandbox in Docker. Opens a private
  Cloudflare tunnel, no inbound ports." Then desktop app buttons (Windows and Linux,
  no macOS), a cleanup command under "Removes all of it", and a sync checkbox showing a
  home directory path.

Phone, first paint: the preselected card is "A cloud machine I own", so the first
screen of the product on a phone is: sign in to Oracle Cloud, generate an API key pair,
paste a configuration file, paste a private key.

The hosted lane, for contrast, is one button ("Start my machine") and three sentences.
It is the calmest screen in the flow.

## Diagnosis

The page has been iterated hard at the micro level. The source narrates dozens of real
fixes: the handoff state machine, the lossless lane switch, the draft rule, the escape
hatches. What remains is macro: what greets a stranger in the first five seconds, and
what those five seconds claim about the product.

### 1. The first decision is one a newcomer cannot evaluate

The page's only real question, where does the sandbox run, is an infrastructure
question with pricing attached. A new account has not seen the product yet. They cannot
weigh "most power, no limits" against "40h a month, then membership" because they do
not know what an hour of the product is worth to them. People asked to choose between
options they cannot evaluate tend to leave rather than guess. The layout reads as plan
picker plus terminal, which tells a chunk of arrivals "this product is for
infrastructure people" before it has shown them anything.

### 2. The desktop default opens with `curl | sudo … sh`

Piping a script from the internet into a root shell is the most alarm-raising string
you can put in front of a hesitant reader. The page knows this: the Docker checkbox
exists purely to strip the `sudo`, and the source calls step 2 "where the flow is most
often abandoned". But the people comfortable with that command are exactly the people
who do not need it preselected. They would find it behind one click without a flinch.
The current default exposes the timid and protects the confident. Defaults should do
the reverse.

### 3. Nothing says the choice is free to explore

The engine underneath is genuinely lossless. Picking a card starts nothing. Switching
lanes keeps the name, the address, and any typing. A hosted machine is handed back
cleanly when you step off the rung. One command removes everything the install
creates. Not one of these guarantees is stated where the choice is made, so the picker
reads as a commitment, and "then membership" reads like entering a plan. The owner's
own words about wizards ("I don't know what my choices impact") describe this page
too. The impacts are knowable and even favorable. The page just never says them.

### 4. Phones default into the scariest lane

The preselection logic predates the hosted rung: the comment says a cloud machine is
"the first path a phone can actually finish alone". Hosted is now that path, one tap
and no credentials, but a phone still lands on the Oracle key pair instructions. A
phone visitor is often someone who tapped a link in a feed. Low commitment, high
bounce propensity, and the first ask is a cloud credential paste.

### 5. Facts come before meaning

The top card spends the page's most valuable position on a name nobody typed, a hex
hostname nobody can parse, and an advanced escape hatch ("Use a different address").
Three things a newcomer must skip over before reaching the only decision. And a
returning bouncer's first sentence is bookkeeping about a sandbox they never knowingly
created ("Made last time you were here, never started"), which confirms the "this is
complicated" prior at the exact moment they gave the product a second chance.

### 6. The reassurance layer speaks the jargon it should be defusing

"Starts your sandbox in Docker." "Opens a private Cloudflare tunnel, no inbound
ports." For readers who know those words, fine. For the readers being lost, each term
raises a question instead of settling one. Reassurance lands when phrased as
consequences: nothing on your machine is exposed to the internet, one command removes
everything, the script is public and short. The vocabulary problem extends to the
page's two names for one thing: the title says workspace, everything else says
sandbox.

### 7. The gentle installer is a sidebar, and a third of laptops cannot use it

The desktop app is the real answer to "I don't want to paste commands". The source
says exactly that. Yet it renders as a right rail afterthought under "Or use the
desktop app", and there is no macOS build (a Mac gets pointed at the generic downloads
page). Mac share among developers is too large for the friendliest path to skip.

## What not to change

- One page, consequence under choice, is the right shape. A wizard would hide the
  impacts this page shows. Keep it.
- Do not default everyone into hosted. The product's identity is agents on hardware
  you own. The hosted rung is a convenience with a real cost behind it. The fixes
  below make the other lanes carry their own safety instead of routing around them.
- The lane engine, the draft rule, and the handoff narration are assets. Everything
  below is copy, ordering, and defaults on top of them.

## Recommendations

### Tier 1: copy and defaults, days of work

1. **State the stakes at the picker.** One muted line under the three cards: "Nothing
   starts until you act below. Switch anytime: your name and address carry over."
   The cheapest fix in this document, aimed at the exact anxiety.
2. **Retitle the rungs by intent, not infrastructure.** "Start instantly: we run it",
   "My computer: most power", "My cloud account". Keep the cost badges. A reader
   picks the sentence that describes them without needing to understand deployment
   topology first. An "Easiest" tag on the hosted card does the guiding that
   reordering or preselecting would, without pushing.
3. **Phone default: hosted when offered, never cloud.** The cloud rung stays one tap
   away for the person it is for.
4. **A trust strip on the command.** One line above the code block, in consequences:
   "Installs Docker if it's missing, starts the sandbox, opens one private outbound
   link. Nothing else. One command removes all of it." With a "Read the script" link
   (the script is already public at the URL the command fetches) and the cleanup
   command beside it. Fear of piped installs is mostly fear of unbounded consequences.
   Bounding them in a sentence, with the script inspectable, is what an installer's
   publisher line would have said.
5. **Demote the hostname.** The address is a consequence, not a decision. Move it to
   the waiting footer ("Your workspace will be at sandbox-….sbx.intentic.dev") or the
   rail. Fold "Use a different address" into the same quiet corner as the Cloudflare
   form it opens. The name row can stay, it is human, but it does not need first
   position.
6. **Rewrite the resume line.** "Picking up where you left off: nothing has run
   yet. Start over instead." Same information, no bookkeeping tone, and not as the
   page's opening sentence.
7. **Soften the hosted badge.** On the card: "Free · 40h a month". What happens after
   the hours belongs in the hosted lane's own card, next to the button, where a full
   sentence fits. Also pick one word, workspace or sandbox, for every string a
   newcomer reads.

### Tier 2: structure, a sprint

8. **Make the app the front door of "My computer" where it exists.** On Windows and
   desktop Linux, the lane's primary action becomes the installer button, and the
   command folds behind "Prefer a terminal? Paste one command." This is the exact
   inversion the page already performs inside the desktop app and on phones, applied
   to the browser too. Terminal people unfold without hesitation. Hesitant people
   never see `sudo`. Ship or schedule the macOS build, and until it exists Macs keep
   command first, which beats a button to nowhere.
9. **Try first visits with no rung preselected.** First paint becomes the question,
   three calm cards, and the stakes line. No sudo, no Oracle, no spinner. The
   consequence appears on the first intentional click, which also feels like progress
   rather than homework. The sandbox and address are still created on arrival, so the
   command is ready the instant a rung is picked. This trades one click for a calmer
   first impression. Run it as an experiment, not a belief (see tier 3).
10. **An exit that is not abandonment.** Under the picker: "Not ready to install
    anything? Look around a sample workspace first," pointing at a read-only demo or a
    90 second recording. Some arrivals are not rejecting the setup. They are not ready
    to commit a machine to a product they have not seen, and today their only move is
    the back button. A recording is cheap even if a live demo is not.

### Tier 3: measure, then argue with data

11. **The funnel already exists.** The page tracks shown, copied, claimed, connected,
    and named failures, per lane and per device (`sandbox_command_copied`,
    `sandbox_command_claimed`, `sandbox_setup_failed`, `sandbox_connected`). Before
    and after any change above, pull: bounce off `/setup` with zero events, lane
    distribution of first picks, the copied to claimed drop (did they run it), the
    claimed to connected drop (did it break). "I have a feeling" is checkable this
    afternoon.
12. **Watch a dozen session replays of `/setup` exits.** Ten minutes of hesitant
    cursors will rank this document's fixes better than any principle.

## The first paint this adds up to

Desktop, new account, nothing preselected:

```
Set up your workspace
Pick where it runs. You'll be working in it in a minute or two.

┌─────────────────────┬─────────────────────┬─────────────────────┐
│ ⚡ Start instantly   │ 🖥  My computer      │ ☁  My cloud account  │
│    we run it        │    most power       │    free 12 GB, or   │
│    Free · 40h/month │    no limits        │    paid             │
│    EASIEST          │    App or 1 command │                     │
└─────────────────────┴─────────────────────┴─────────────────────┘
Nothing starts until you act below. Switch anytime — nothing is lost.

Not ready to install anything? Look around a sample workspace first.
```

One decision, one line of reassurance, no terminal above the fold. Everything that is
scary today still exists, one intentional click deeper, wearing a trust strip and an
undo.

## Decisions, 2026-08-20

The owner ruled out every recommendation that adds explanatory copy (the stakes line,
the trust strip, the demo escape): added reassurance goes unread or reads as
over-explaining. Rewording at similar length was approved and shipped:

- Rungs retitled by intent: "Start instantly" (was "We host it"), "My own computer"
  (was "A computer I own"), "My cloud account" (was "A cloud machine I own"). The
  hosted note now says "Runs on our servers", so whose machine it is stays on the card
  after the title stopped saying so.
- The hosted badge's "then membership" became "more with membership": same fact, an
  upgrade instead of a scheduled subscription.
- The resume line leads with continuity ("Picking up where you left off: nothing has
  run yet") instead of bookkeeping ("Made last time you were here, never started").
- A phone now defaults to the hosted rung whenever one is offered. The cloud rung had
  the phone default from before hosting existed, and it opens on a credential paste.

The two structural items shipped in the same session, after the wording:

- **The hostname left the top card.** The address row, its "Use a different address"
  escape hatch and the own-Cloudflare form all moved onto the run card, above the
  command whose hostname they describe. The card that opens the page is now one line:
  the name, with its pencil. First paint reads name, then the three rungs: the
  decision is no longer third in line behind two things nobody typed. The move also
  fixed a smaller lie: the lock under the command used to say "the token above" about a
  field two cards up and off screen.
- **The app is the front door of "My own computer"**, wherever a build exists for the
  machine reading the page. A browser on Windows or Linux opens that rung on a download
  button, with the command behind "Prefer a terminal? Show the command": the same
  disclosure the desktop app and phones already use. macOS has no build, so a Mac keeps
  the command first: a button pointing at a downloads page with nothing on it for you is
  worse than the pipe it would replace. Three things ride along so the page doesn't lie
  once the command is folded: the wait line names the install rather than a paste, the
  stuck-wait nudge gets a reader of its own, and the reference column drops its now
  duplicate download buttons.

A third change followed from looking at the result: **the rungs are illustrated rather than
iconed.** A 16px bolt beside "Start instantly" is a synonym for the word next to it, so the
space it took said nothing twice. The cards now carry a drawing each: a cloud with a bolt
in it, a monitor with work on the screen, a rack of three. Where the machine lives is the
one thing on this page a newcomer cannot look up, and a picture answers it before the
titles are read. That is what earns the height a glyph could not.

The first attempt at those drawings was rejected on sight, and rightly. It was chunky:
thick rounded strokes around washed-in fills, a sticker-illustration language this product
speaks nowhere else. Every icon in the app is Remix's line set: a 24 grid, hollow shapes,
a thin even band, sharp geometry, small solid details. The drawings are now the same hand
at five times the size, and the bolt is literally the app's own `flashlight-line`
silhouette scaled up, which is the cheapest guarantee it cannot drift from the icon set.

The cloud is the one shape drawn fresh, and it took a second pass to get right. Scaling up
`cloud-line` looked like the safe move, but that glyph is nearly square on its grid: which
nobody reads at 16px and everybody reads at 100px. Sat beside a monitor and a rack that are
both plainly landscape, a square cloud stops looking like a cloud and starts looking like a
lump. It is now drawn wide, about 1.75:1, in the same band and the same arcs-only geometry
as the set it lives in. A drawing scaled past the size it was designed for is worth
re-checking against its neighbours, not just against its source.

One thing to know if these are edited: the artwork's opacities are SVG attributes, not
utility classes. The first version dimmed its fills with a class used nowhere else in the
app, so the class was never generated for the running dev server and the drawings shipped
at full strength: a solid white cloud and a solid orange monitor. Colour survived only
because those classes existed elsewhere. A drawing's opacity belongs in the drawing.

The Linux half is the one to watch. An AppImage asks more of a reader than an `.exe`
does, and a Linux desktop user is likelier than most to have wanted the terminal anyway.
If the funnel shows that rung converting worse on Linux than on Windows, narrow the
installer-first default to Windows and leave Linux on the command: one condition.

Dropped on reflection: mounting with no rung preselected, because it hides each choice's
consequences until after the pick, which is the wizard problem the one page layout exists
to avoid.

## Where the rejected copy went, 2026-08-29

Three recommendations above were ruled out on 2026-08-20 for being explanatory copy that
goes unread or reads as over-explaining: the stakes line (1), the trust strip (4), and the
demo escape (10). That judgement stands **for this page**, and it was the right call about
the wrong location. Each of the three answers a question a reader has *before* they are
signed in, and `/setup` is on the far side of a Google prompt: by the time anybody reads
it they have already committed, which is exactly why explanation there is noise.

So the split is by reader, not by page. The public site now carries
**[/where-it-runs/](../_site/site/src/pages/where-it-runs.astro)**: the same three rungs
with the whole trade stated at the length the decision deserves — what each costs, what it
asks of you, what the install creates, what removes it, with both scripts linked as plain
text — plus the two exits (the demo, the desktop app) for a reader who is not ready to
install anything. It is static, signed-out, and free to be as long as it needs to be,
because nothing on it is standing between anybody and a workspace.

`/setup` did not grow a word. It gained one query parameter: **`?machine=hosted|mine|cloud`**,
which the site's rung cards link through, so a choice made after reading three paragraphs
opens the app already on that rung instead of asking again. It outranks the device default
(a phone that arrives on `?machine=mine` is somebody reading about the desktop they are
sitting at) and is validated against the rungs this platform actually offers, so a stale or
self-hosted link falls back to the ordinary default rather than to a step that cannot unlock.

The page is deliberately **not in the top bar**, for the reason `nav.ts` already gives about
`/download`: a permanent tab beside "Create your workspace" offers two openings where there
is one. It sits where the hesitation actually lands — under the home page's install command,
on the download page, in the quickstart's preamble, and in the footer's Resources column.

What is still worth measuring (tier 3 above is unchanged): whether arrivals through
`?machine=` convert better than cold arrivals at `/setup`, per rung. If they do, the
argument for moving more of the decision off the app screen gets stronger; if they do not,
this page is cheap to leave standing as the answer to a search rather than a funnel step.

## The material, 2026-08-30

Everything above this section is about what the page **says**. This one is about what it is
**made of**, which had never been looked at and turned out to be the loudest thing wrong with
it: read straight after `/login`, the two screens were visibly from different companies.

`/login` is built out of the marketing site's own vocabulary — the carved temple plate, Playfair
cut in stone with an ember full stop, gold hairlines, a turned corner in each elbow, the lotus
finial, a cast-bronze plaque for the one thing you press. `/setup` was the app's ordinary
chrome the moment you arrived: a flat canvas with no ground at all, a 16px medium `h1` of the
weight a settings tab gets, three cards whose chosen one was marked by a one-pixel border the
same weight as the two it beat, and a primary button that is a 10% tint of the accent inside a
20% rule — which on a near-black page is also the description of the card behind it and the
field beside it. The eye finds differences of *lightness* first, so on the one screen whose
entire job is to get somebody to press something, nothing looked pressable.

What shipped:

- **The material moved out of `Login.vue` into [`styles/entry.css`](../_editor/web/src/styles/entry.css)**,
  scoped to `.entry`, and both screens wear it. The door keeps its own composition (centred on
  the art's empty middle, one control); the setup page is laid out like one of the site's
  article pages, left down the column the work is in. Nothing is duplicated, which is what
  makes it safe for the next entry screen to join them.
- **The page has a ground.** The same plaque, cropped to a band across the top and dissolved
  into canvas by a veil before the picker starts — the site's own `PageBackdrop` argument. The
  masthead stands on carving; every line anybody has to *work* on sits on flat opaque canvas,
  because a caption over a photograph reads at a different contrast in every line.
- **A masthead instead of a heading.** The mark, an eyebrow, the carved headline, a lede. The
  eyebrow is "Your sandbox is waiting", which is verbatim the second of the three beats the
  sign-in screen's progress rail names — so the screen a visitor lands on announces itself as
  the station they were just shown rather than as a new subject.
- **Choosing a rung turns its corners.** The chosen plate lifts, its rule goes to full gold,
  the four elbows are drawn and the mark beside its name lights ember. A turned corner is how
  every frame on intentic.dev says *this one is a thing*, so the selection signal is one the
  reader has never had to be taught, and it does not depend on telling two hairlines apart.
- **The run card is the page's one framed object**, with the lotus astride its top rail — the
  panel every rung leads to and every press happens on. The reference column keeps the plain
  plate: reference material is not a decision, and an elbow at each corner would claim it was.
- **The committing button is cast bronze**, the site's own primary, and it is the only
  light-on-dark object on the screen. Secondary is the plain stone cartouche; `text`, `danger`,
  `warn` and `success` are left exactly as the design system draws them, because a destructive
  button repainted in the house metal is a destructive button nobody reads as one.

Two mechanical notes worth keeping, because each cost a wrong turn:

- **`.entry` restates `--color-*`, never `--role-*`.** `--color-card: var(--role-card)` is
  declared in `@theme`, i.e. on `:root`, and a custom property's `var()` references are
  substituted on the element that *declares* it — children inherit an already-resolved value.
  Re-pointing a role token from a descendant therefore changes nothing at all. A skin gets away
  with it only because it sits on `<html>`. The same trap is why the two PrimeVue components
  these screens use (the button tiers and the checkbox) have to be named explicitly: their
  `--p-*` tokens resolved against the app's palette long before `.entry` existed.
- **The radius scale is deliberately left alone.** Squaring `--radius-*` here would square the
  app's utilities and leave every PrimeVue control rounded, which is half a decision and worse
  than either whole one. The square corner is drawn where these screens draw a frame *by hand*;
  nested controls keep their own rounding, exactly as the door already composes Google's rounded
  button inside its square socket.

Not changed, and not by accident: not a word of copy, not one control, not one lane, not one
default. The decisions recorded above all still hold — this is the same page, in the stone the
page before it is cut from.
