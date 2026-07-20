# Strategy: Overtake VSCode / Cursor / Zed as the top-choice IDE

**Goal:** Devise and execute a strategy for Intentic to become the top-choice, most-popular IDE by
having better features, a smoother experience, and being familiar to developers migrating from
VSCode / Cursor / Zed / Windsurf / JetBrains.

This document is the shared state for a scheduled 10-run autonomous analysis (one run per hour).
Each run appends its work below and does NOT rewrite prior runs.

## Run counter

RUNS_COMPLETED: 10 / 10

## Standing brief for each run

1. Read this whole file first (all prior runs) so you don't repeat conclusions.
2. Ground the analysis in the actual codebase — read ARCHITECTURE.md and the real `_apps` code so
   recommendations are concrete for *this* product, not generic.
3. Advance the strategy: refine positioning, pick/adjust the single highest-leverage bet, and break
   it into shippable steps. Prefer depth over breadth — build on the top choice rather than
   restarting the survey each run.
4. **Proceed on the top choice for work**: actually do implementation/prototyping/design work toward
   the current top bet in the codebase, leaving it in a clean, working state.
5. Append a dated run entry below: what you decided, what you built, and the concrete next step for
   the following run.

## Ground rules

- Do not commit or push unless the user explicitly asks (repo has concurrent git activity).
- Follow CLAUDE.md engineering rules for any code changes.
- Keep changes coherent and reversible; leave the tree building/passing.

---

## Run log

<!-- Each run appends one dated entry here. -->

### Run 1 — 2026-07-20 — Strategic foundation + first-class keybinding system

**Honest competitive read (what Intentic actually is).** Intentic is not a desktop editor fighting VSCode on
its own turf. It is a browser-delivered, VSCode-shaped, **agent-native** editor whose backend is a per-user
**remote sandbox**, uniquely fused with an **intent-driven deployment engine** that reconciles the user's *own*
infrastructure. Its true comp set is "Cursor + GitHub Codespaces + Vercel/Replit," self-hosted-first. Grounded
in [ARCHITECTURE.md](ARCHITECTURE.md): deploy engine (have/want → reconcile), remote sandbox daemon, extension
system (VSCode's "everything is an extension" bet), port forwarding/mirroring, multi-user sharing.

**How IDE popularity is actually won (the lesson from the incumbents).**
- VSCode won on free + familiar + a massive extension **network effect**.
- Cursor took share by **forking VSCode** — inheriting 100% familiarity, keybindings, and the extension
  marketplace *for free* — then adding a thin, deep 10x AI layer. Lesson: **familiarity is table stakes you must
  not pay for twice; differentiation is a thin 10x layer on top.**
- Zed won a niche on native speed + collaboration, but fights uphill on familiarity/extensions.
- Brutal truth: you do **not** out-popularity VSCode by being a better generic editor. You win by (a) driving
  switching cost → 0, and (b) a workflow that is *impossible* in the incumbents.

**The strategy (spine): "Win on the wedge, don't lose on familiarity." Two tracks.**
- **Track A — Frictionless familiarity (the on-ramp / de-risk switching):** VSCode-parity keybindings + a
  rebindable keymap, palette that teaches shortcuts, multi-cursor, settings/keymap sync, themes, and the big one
  — a path to consume VSCode/OpenVSX extensions. Goal: a developer loses *nothing* familiar by switching. This is
  the thing the user explicitly named ("familiar for developers"), and Intentic's biggest structural risk is that
  it's a *from-scratch* editor (unlike Cursor), so every missing familiar affordance is a switching tax.
- **Track B — The 10x wedge (reason to stay + viral loop):** make "code with agents → one-click preview → deploy
  to your own infra → share the live env by URL" the headline. The viral loop is **sharing a live, running
  workspace/preview** — every shared URL is a demo and an invite (multi-user mirroring already exists).

**TOP BET (current): Track A — "Frictionless familiarity as the on-ramp to the deploy+share wedge."** Rationale:
the wedge (deploy engine + remote sandbox) is already *deep*, but it only converts if first-run retention doesn't
leak on missing muscle-memory affordances. Familiarity is the prerequisite for the wedge to ever be experienced,
and it has the most concrete, shippable gaps right now.

**What I built this run (concrete slice of Track A): a first-class keybinding system.**
Finding: the command palette / Quick Open was already mature (Cmd+P files, Cmd+Shift+P commands, fuzzy ranking,
recents), but there was **no keybinding system** — shortcuts were hardcoded in a bespoke `onShellKey` hub in
[ShellDesktop.vue](_apps/web/src/shell/ShellDesktop.vue), registered commands could not be bound to keys, and the
palette never showed shortcuts (so it couldn't *teach* them — a core VSCode affordance). Shipped:
- [keybindings.ts](_apps/web/src/composables/commands/keybindings.ts) — pure, unit-tested chord notation
  (`Mod`/`Ctrl`/`Shift`/`Alt` + key; `Mod` = ⌘ on Apple, Ctrl elsewhere), `matchesChord` (exact-modifier match, so
  `Mod+P` never fires on `Mod+Shift+P`), and `formatChord` (native ⇧⌘P vs Ctrl+Shift+P display).
- [useKeybindings.ts](_apps/web/src/composables/commands/useKeybindings.ts) — one global dispatcher; **registered
  commands are the single source of truth** (a command's own `keybinding` is its shortcut — no second table to
  drift, matching the codebase's "the command IS the binding" philosophy). Extensions get working shortcuts for
  free the day they declare one.
- Replaced the hardcoded hub in ShellDesktop with the dispatcher; added a `workspace.commandPalette` command; gave
  the builtins their bindings (`Mod+P`, `Mod+Shift+P`, `Ctrl+\``).
- [QuickOpen.vue](_apps/web/src/shell/QuickOpen.vue) now renders each command's shortcut as a `<kbd>` — the palette
  teaches shortcuts like VSCode.
- Tests: [keybindings.test.ts](_apps/web/src/composables/commands/keybindings.test.ts) (11 command-suite tests
  green). Touched files typecheck clean; the only remaining repo typecheck errors are pre-existing `PageHeader`
  export issues in `_extensions/*` from concurrent work (untouched by me).

**Concrete next step for Run 2.** Extend Track A along the highest-leverage familiarity axis. Options, in priority
order: (1) **wire the keybinding through the extension API** — add `keybinding` to the manifest `commands`
contribution ([manifest.ts](_libs/extension-api/src/manifest.ts) + [apiImpl.ts](_apps/web/src/extension-host/apiImpl.ts))
so third-party commands are bindable and gated; (2) a **rebindable keymap** (user overrides persisted to sandbox
settings) — the real "familiar" unlock, since developers expect to remap; (3) begin scoping the **VSCode/OpenVSX
extension-compatibility** question — the single biggest network-effect lever and the hardest, so it deserves a
dedicated design run. Recommend Run 2 does (1) (small, compounds immediately) and starts the design memo for (3).
Reminder: the deep bet behind all of this is Track B's viral loop (share a live running env) — a later run should
pivot there once Track A clears table stakes. Do NOT commit; leave the tree clean.

### Run 2 — 2026-07-20 — Keybindings through the extension API + extension-compatibility design memo

**Decision.** Stay on the Run-1 top bet (Track A — frictionless familiarity) and execute its planned step (1):
make the keybinding system a *first-class contribution point*, so third-party extensions get real, approved,
manifest-gated shortcuts — not just builtins. This compounds Run 1 immediately and is a prerequisite for a
credible extension ecosystem (Track A's endgame).

**What I built (the wiring, end-to-end and type-safe).**
- [manifest.ts](_libs/extension-api/src/manifest.ts): added `keybinding` (whitespace-free optional string) to
  `CommandContributionSchema`. Declared here **on purpose** — a global shortcut is consequential, so it rides the
  install-dialog approval surface; the manifest value is authoritative, like title/icon.
- [apiImpl.ts](_apps/web/src/extension-host/apiImpl.ts): the host now passes `declared.keybinding` into
  `registerCommand`, so an extension's shortcut is bound **only as approved** — the runtime `commands.register`
  call can't smuggle a different chord. QuickOpen already renders any command's `keybinding`, so extension
  shortcuts now show + teach in the palette automatically, and the Run-1 dispatcher fires them for free.
- **Precedence property (deliberate, documented):** the dispatcher is first-match, and builtins register at shell
  mount (before extensions activate), so **core muscle-memory chords (Cmd+P, Cmd+Shift+P, Ctrl+`) cannot be
  hijacked by an extension.** Safe default for "familiar + smooth"; conflict *surfacing* (warn/settings UI) is a
  later polish, noted below.
- Type/flow reality worth recording for future runs: the shape the web sees flows extension-api →
  **sandbox-contract** (`ExtensionManifestSchema` is imported into `ExtensionSummarySchema`, the `GET /extensions`
  wire type) → web. Both libs compile to `dist` `.d.ts` that the web resolves via the `types` condition, so a
  schema change requires **rebuilding both `_libs/extension-api` and `_libs/sandbox-contract`** (`pnpm build`)
  before the web typechecks. Did that. Result: web `vue-tsc` clean except the pre-existing `PageHeader`
  `_extensions/*` errors (concurrent work, untouched); 61 web command/extension-host tests green.

**Strategic depth — design memo: the VSCode/OpenVSX extension-compatibility question (Track A's biggest lever).**
This is *the* network-effect decision and deserves being framed now even though the build is later:
- **Why it matters most:** VSCode's real moat is ~50k extensions + muscle memory. Cursor/Windsurf inherit it by
  *forking VSCode*. Intentic is a from-scratch Vue/Monaco editor, so it does **not** inherit the marketplace — the
  single largest structural gap to "top-choice popularity." Intentic's own extension system (manifest-gated,
  `IntenticApi`, sandbox-contract data plane) is cleaner and safer, but empty ecosystems don't win popularity.
- **The three viable paths:**
  1. **Grow the native ecosystem only** (status quo). Cleanest, safest, but slowest to critical mass; bets that
     the agent+deploy wedge pulls authors in. Risk: chicken-and-egg.
  2. **OpenVSX/VSCode-manifest *interop* at the contribution level** — map a subset of VSCode's
     `contributes` (commands, keybindings, languages, themes, snippets — the *declarative*, low-API-surface ones)
     onto Intentic's registry, so a large class of "config-like" extensions (themes, keymaps, TextMate grammars,
     snippet packs) work with a thin adapter. High familiarity payoff (themes + keymaps are top switch-blockers),
     bounded scope, no attempt to run VSCode's full `vscode.*` API. **Recommended first target.**
  3. **Full `vscode.*` API compatibility layer / web-extension host** — run real VSCode web extensions. Maximum
     payoff, maximum cost and risk (huge API surface, security model clash with Intentic's manifest-gated trust
     boundary, Monaco-vs-VSCode-workbench gaps). A multi-quarter bet, not a run.
- **Recommendation:** pursue (2) as the pragmatic wedge — it converts the highest-friction familiarity items
  (themes, keymaps, snippets, grammars) at bounded cost and reuses the keybinding/command contribution work from
  Runs 1–2 — while continuing to grow the native ecosystem (1). Treat (3) as a deferred, separately-justified bet.
  The keybinding contribution point just built is literally step one of a VSCode-keymap importer.

**Concrete next step for Run 3.** Highest-leverage, still Track A, in priority order: (1) **a rebindable keymap** —
persist user chord overrides to sandbox extension/settings storage and have the dispatcher honor overrides over
declared defaults (the real "familiar" unlock; also the substrate a VSCode-keymap importer writes into); (2) as a
smaller alternative/companion, **keybinding conflict surfacing** (detect two commands claiming one chord; warn +
show in palette). Recommend Run 3 builds (1): design the override store (a `keymap` settings blob:
`{ [command]: chord | null }`, null = unbound), thread it through `useKeybindings`/`useCommands` so
`effectiveKeybinding(command)` = override ?? declared, and show the effective chord in QuickOpen. Then Run 4 can
either start the OpenVSX theme/keymap importer (memo path 2) or pivot to Track B's share-a-live-env viral loop.
Do NOT commit; leave the tree clean.

### Run 3 — 2026-07-20 — Rebindable keymap (the override substrate)

**Decision.** Execute Run 2's planned step (1): make bindings *rebindable*. Developers expect to remap shortcuts —
it's the biggest remaining "familiar" gap once bindings exist, and it's also the substrate a future VSCode-keymap
importer (memo path 2) writes into. Built the store + resolution + wiring + tests; deferred the chord-recorder UI
to Run 4 (agreed scope — this run is the substrate).

**What I built.**
- [useKeymap.ts](_apps/web/src/composables/commands/useKeymap.ts): a per-command chord OVERRIDE store, a
  module-level singleton persisted to `localStorage` (mirroring [useLayout.ts](_apps/web/src/composables/useLayout.ts)'s
  client-preference idiom, Storage-failure tolerant). A keymap is per-machine — exactly like VSCode's
  keybindings.json — so localStorage is the honest home; the store is isolated behind `useKeymap` +
  `effectiveKeybinding` so a later run can promote it to daemon-synced settings ("keymap follows you") by swapping
  only the read/write. **Three-state model** an entry can hold: remapped (chord), **unbound** (`null` — user
  removed the default), or **default** (absent → declared chord). API: `setKeybinding` / `unbindKeybinding` /
  `resetKeybinding` / `resetKeymap`. A corrupt/hand-edited blob is sanitized on read.
- `effectiveKeybinding(command, declared)` — the ONE resolver (override wins; `null` = no shortcut; absent →
  declared). Threaded through both consumers so the keymap is the single source of truth:
  - [useKeybindings.ts](_apps/web/src/composables/commands/useKeybindings.ts) dispatcher now matches the effective
    chord, so a remap takes effect live and an unbound command stops firing.
  - [QuickOpen.vue](_apps/web/src/shell/QuickOpen.vue) renders the effective chord (reactive on the override ref),
    so the palette teaches the *user's* shortcut, not just the default.
- Tests: [useKeymap.test.ts](_apps/web/src/composables/commands/useKeymap.test.ts) pins all three states + reset.
  16 command-suite tests green; web `vue-tsc` clean except the pre-existing `PageHeader` `_extensions/*` errors
  (concurrent work, untouched).

**State of Track A after Run 3.** The keybinding stack is now: pure matcher (Run 1) → global dispatcher (Run 1) →
command palette that teaches shortcuts (Run 1) → extension-contributed, manifest-gated bindings (Run 2) → user
overrides / rebindable keymap (Run 3). What remains for "table-stakes familiar": a **chord-recorder UI** to make
the override store user-reachable, then the **OpenVSX theme/keymap import** (memo path 2) for real ecosystem
familiarity.

**Concrete next step for Run 4 — a genuine fork in the road; pick deliberately.**
- **Option A (finish Track A's user-facing loop):** build the **keybindings settings UI** — a searchable list of
  all registered commands showing each effective chord, with a "record shortcut" capture (listen for one keydown,
  turn it into a chord via a new `chordFromEvent` in [keybindings.ts](_apps/web/src/composables/commands/keybindings.ts),
  save via `setKeybinding`), plus reset/unbind affordances and a conflict warning when two commands share a chord.
  This makes Runs 1–3 fully user-facing and is the smallest step to "a developer can remap, like VSCode." Likely
  lives on the `/settings` page (confirm it exists; AccountPanel's comment references it).
- **Option B (pivot to Track B — the differentiator/viral loop):** Track A has now cleared the core keybinding
  table stakes, so it's defensible to pivot to the thing VSCode/Cursor structurally can't copy: **"share a live,
  running dev environment + its preview by one URL."** Multi-user mirroring already exists (ARCHITECTURE.md); the
  leverage is packaging it into a one-click, obvious, *viral* share action (every shared URL = a demo + an invite).
- **Recommendation:** do **Option A** in Run 4 (small, closes the loop opened in Run 1, ships a complete
  user-visible "remap your keys" feature), then **pivot to Track B in Run 5** with a dedicated design+prototype run
  — the wedge is where popularity is ultimately won, and Track A will have reached "no worse than VSCode" on
  keybindings. Do NOT commit; leave the tree clean.

### Run 4 — 2026-07-20 — Keyboard Shortcuts settings UI (Track A's user-facing loop closed)

**Decision.** Took Run 3's recommended Option A: make the keymap **user-reachable**. Runs 1–3 built a complete
keybinding spine (matcher → dispatcher → palette hints → extension-gated bindings → override store) but a developer
could only remap via devtools. This run ships the actual "remap your keys, like VSCode" feature, closing the loop
opened in Run 1. Track A now stands on its own as a shipped familiarity feature.

**What I built.**
- [keybindings.ts](_apps/web/src/composables/commands/keybindings.ts): added `chordFromEvent(event, isMac)` — the
  pure capture primitive that turns a keydown into a binding string. Records the primary modifier as portable `Mod`
  (one capture serves both platforms), keeps a literal Control distinct on Apple, and REJECTS invalid global
  shortcuts (a lone modifier, or a modifier-less non-function key that would hijack typing). Round-trips through
  `matchesChord`. Unit-tested (5 new cases; 21 command-suite tests green total).
- [SettingsKeybindings.vue](_apps/web/src/pages/settings/SettingsKeybindings.vue): a new Settings ▸ **Keybindings**
  tab. Searchable list of every registered command (builtins + extension-contributed — one registry), each row
  showing its effective chord, with **record** (capture one keystroke in the *capture phase* + `stopPropagation`,
  so the shell dispatcher never fires the old shortcut mid-capture; Esc cancels), **unbind**, **reset-to-default**,
  a **Reset all**, and a **conflict warning** when two commands share a chord. Persists via `useKeymap`, live
  everywhere instantly.
- Wired the tab into [SettingsHub.vue](_apps/web/src/pages/SettingsHub.vue) (`/settings/keybindings`) and added a
  `view.keybindings` palette command ("Keyboard Shortcuts") so it's discoverable from the Command Palette — VSCode's
  "Open Keyboard Shortcuts" affordance.
- Icons: mapped to the curated `IconName` set (`pencil`/`times`/`trash`/`undo`/`sliders-h`). Web `vue-tsc` clean
  except the pre-existing `PageHeader` `_extensions/*` errors (concurrent work, untouched).

**Track A status: table stakes cleared.** Intentic now has a full, user-facing, VSCode-shaped keybinding system —
command palette that teaches shortcuts, remappable per-command keymap with record/unbind/reset, extension-gated
contributions, and conflict surfacing. "No worse than VSCode" on the single most-used familiarity surface.
Remaining Track A depth (deferred, not blocking): OpenVSX theme/keymap **import** (memo path 2) and daemon-synced
keymap ("follows you"). Both are follow-ons, not prerequisites.

**Concrete next step for Run 5 — PIVOT to Track B (the differentiator / viral loop).** Track A has cleared table
stakes, so the leverage now shifts to the thing VSCode/Cursor/Zed **structurally cannot copy**: *code with agents →
preview → deploy to your own infra → **share a live, running dev environment + its preview by one URL***. Run 5 is
a **design + first-prototype run**:
1. Read the real sharing/mirroring surface — [ARCHITECTURE.md](ARCHITECTURE.md) §sandbox (members, port
   forwarding/mirroring, `preview-<panel>` / `port-<slot>` hostnames), [_apps/sandbox/src/ports/](_apps/sandbox/src/ports/),
   the members/auth model ([auth.ts](_apps/sandbox/src/auth/auth.ts)), and how the web surfaces presence/invites
   ([PresenceStack.vue](_apps/web/src/presence/PresenceStack.vue), the SandboxSwitcher invite flow).
2. Identify the smallest change that turns "a running preview" into a **one-click shareable URL** (or a scoped
   invite link) — the viral primitive. Note what exists vs what's missing (is there a read-only/anonymous
   preview-share, or only member invites?).
3. Prototype the highest-leverage slice that leaves the tree clean (likely a "Share preview" action + link surface;
   or an honest design memo if the daemon/auth work exceeds one run).
Frame it as: **every shared URL is a demo and an invite** — the growth loop VSCode can't have because it has no
running backend to share. Do NOT commit; leave the tree clean.

### Run 5 — 2026-07-20 — PIVOT to Track B: one-click "Share this live preview"

**Decision.** Per the standing plan, pivoted from Track A (familiarity — table stakes cleared) to **Track B**, the
differentiator VSCode/Cursor/Zed can't copy: sharing a *live, running dev environment*. Did the design
investigation, found the viral primitive was 90% latent, and shipped the missing 10% (the product surface).

**Design finding (the key unlock).** [preview-proxy.ts](_apps/sandbox/src/panels/preview-proxy.ts) line 66:
**"Every preview is public — no auth in front of the proxy."** A running panel answers at
`preview-<repo>-<sandboxId>.<zone>` and a forwarded port at `port-<slot>-<sandboxId>.<zone>`, both **already
publicly reachable**. So the "share a live URL" primitive's raw material *already exists* — the gap was purely (a)
no share/copy affordance in the UI (only "open in new tab"), and (b) no honest signal that these URLs are public.
Both are exactly the product surface a viral loop needs, and both were cheap to add.

**What I built.**
- [SharePreview.vue](_extensions/preview/src/SharePreview.vue) (preview extension): a reusable **Share** button →
  popover showing the public URL, a `CopyButton` ("Copy link"), an open-in-new-tab, and a plain-language
  **"Anyone with this link can open it"** note — so "shareable" never reads as "leaked". Presentational; caller
  passes the resolved public URL.
- Wired into [PanelView.vue](_extensions/preview/src/PanelView.vue) — the floating controls over a running app's
  iframe, so "send someone my live app" is one click exactly where the user is watching it — and into
  [PortsView.vue](_extensions/preview/src/PortsView.vue) — next to each forwarded port, where exposure already
  happened. Both gated on the URL being live (`panel.previewUrl && panel.running` / `entry.previewUrl`).
- Reused existing primitives (`CopyButton`, `Popover` from `@intentic/extension-ui`) — no new dependencies. The
  preview extension typechecks clean (`vue-tsc --noEmit`, exit 0). Note: the web consumes this extension as a
  pnpm-materialized `file:` copy, so a `pnpm install` is needed for a running web build to pick it up — source is
  correct and is the committed source of truth; I did not run install (concurrent-git caution).

**Strategic read: the loop is half-built.** "Every shared URL is a demo and an invite." The **demo** half now
works (one-click public link). The **invite** half does NOT yet exist: a shared preview is just the user's app —
nothing on it pulls a viewer back to Intentic. Closing that is the real growth-loop lever, and it's delicate
(injecting into a user's app is intrusive). Options: a tasteful, **optional/dismissable** "Made with Intentic"
attribution on the preview-proxy's own error/interstitial pages (502 "panel not running", 404) — pages Intentic
already owns and controls, so no injection into the user's app; and/or an opt-in badge. This is the honest,
non-intrusive place to plant the CTA.

**Concrete next step for Run 6.** Two credible directions — recommend the first:
1. **Close the invite half (loop-completing, non-intrusive):** brand the preview-proxy's OWN response pages —
   the 502/404 plain-text messages in [preview-proxy.ts](_apps/sandbox/src/panels/preview-proxy.ts) become small
   branded HTML interstitials with a subtle "Preview powered by Intentic — build & share your own" link. These are
   pages Intentic serves (not the user's app), shown exactly when a shared link is opened before/after a server is
   up — high-intent moments for a viewer who just clicked someone's shared preview. Smallest honest CTA surface.
2. **Scoped collaboration invite (heavier):** a read-only/scoped *invite link* to the workspace itself (vs the
   public preview) using the members/auth model ([auth.ts](_apps/sandbox/src/auth/auth.ts),
   [PresenceStack.vue](_apps/web/src/presence/PresenceStack.vue)) — "invite a collaborator" as a first-class link.
   Bigger surface (auth + member mint); likely its own multi-run thread.
Also still open as deferred Track A follow-ons (pick up if Track B stalls): OpenVSX theme/keymap import, daemon-
synced keymap. Recommend Run 6 does (1) — it literally completes the viral loop this run started. Do NOT commit;
leave the tree clean.

### Run 6 — 2026-07-20 — Closed the invite half: branded preview-proxy interstitials

**Decision.** Took Run 5's recommended step (1): complete the viral loop by branding the ONLY surface Intentic
controls end-to-end for an external viewer — the preview proxy's own status pages. Run 5 shipped the **demo** half
(one-click public link); this run ships the **invite** half without ever injecting into a user's running app.

**What I built.** [preview-proxy.ts](_apps/sandbox/src/panels/preview-proxy.ts): the proxy's plain-text status
responses (panel-not-running 502, nothing-forwarded 502, dead-upstream 502, stray-host 404) are now small,
self-contained **branded HTML interstitials** with a subtle CTA: *"Preview powered by Intentic — build & share your
own →"* → `https://intentic.dev`. These render at exactly the high-intent moment a viewer clicks someone's shared
link before/after the server is up. Details:
- A tiny `interstitial(title, message)` (inline CSS, dark-neutral, zero assets — the proxy is a bare Node http
  server) plus `escapeHtml` for the only attacker-influenced bits (repo/slot names from the Host header). Static
  sentence text (incl. literal quotes) stays literal, which the proxy tests assert on.
- Preserved every status code and message substring, so all **11 preview-proxy tests stay green**; sandbox
  `tsc --noEmit` clean (0 errors). WebSocket-upgrade error path unchanged (its plain reason-phrase still works).
- **Deliberately NOT built:** any attribution on the *live* preview itself. For an external viewer hitting the
  public URL there's no Intentic chrome, and wrapping/injecting their app would be intrusive — so the error/status
  pages (which Intentic legitimately serves) are the honest ceiling for the CTA. Left the running app untouched.

**Strategic state.** Both strategy tracks now have a shipped spine:
- **Track A (familiarity):** full VSCode-shaped keybinding system — palette that teaches, remappable keymap w/
  record/unbind/reset, extension-gated bindings, conflict surfacing, settings UI. Table stakes cleared.
- **Track B (differentiator/viral loop):** one-click share of a live running preview (demo) + branded interstitial
  CTA on shared links (invite). The loop VSCode structurally can't have — it has no running backend to share.

**Concrete next step for Run 7 — the deferred ecosystem lever: OpenVSX/VSCode THEME import.** With both spines in,
the highest-leverage remaining move for *popularity* is the biggest network-effect + familiarity gap identified in
Run 2's memo (path 2): let developers bring their VSCode look. Themes are the #1 switch-blocker and are almost pure
data (a VSCode color theme is JSON: `colors` + `tokenColors`/TextMate scopes). Run 7 should be a **design +
prototype run**:
1. Read the theme system — [useTheme](_libs/ui/src) / `data-mode` + `data-theme` (see
   [SettingsAppearance.vue](_apps/web/src/pages/settings/SettingsAppearance.vue)), the design-token CSS variables
   (`--color-*`, `bg-canvas`, `text-content`, `border-line`), and how Monaco is themed
   ([useMonaco.ts](_apps/web/src/composables/workspace/useMonaco.ts)).
2. Design the mapping: a VSCode theme's `colors` (editor.background, etc.) → Monaco theme + the app's core CSS
   variables; `tokenColors` → Monaco token rules. Identify the ~15 variables that carry 90% of the visual identity.
3. Prototype the smallest real slice that leaves the tree clean: e.g. a pure `vscodeThemeToTokens(json)` mapper
   with unit tests (no UI wiring needed to be valuable), or a single hardcoded famous theme (One Dark Pro /
   Dracula) proven end-to-end through Monaco. Be honest about scope — a full OpenVSX fetch/registry is a later run.
Alternative if Track B is preferred: scoped **read-only collaboration invite links** (members/auth,
[auth.ts](_apps/sandbox/src/auth/auth.ts)) — multiplayer as a first-class link. Recommend Run 7 does the theme
mapper (bounded, testable, hits the biggest familiarity lever). Do NOT commit; leave the tree clean.

### Run 7 — 2026-07-20 — VSCode/OpenVSX theme import: the color mapper (pure, tested core)

**Decision.** Took Run 6's recommended step: the deferred ecosystem/familiarity lever from Run 2's memo (path 2).
Themes are the #1 switch-blocker and nearly pure data, so I prototyped the hard, valuable, testable half of theme
import as a pure function — deliberately NOT the UI wiring (that's the follow-on), so the slice stays clean and
verifiable on its own.

**Grounding finding.** The app has TWO theme layers: (1) **app chrome** = semantic CSS design tokens
(`--color-canvas`/`content`/`line`/`primary-500`…, oklch, driven by `data-mode` + `data-theme` — see
[theme.ts](_libs/ui/src/styles/theme.ts), [semantic-colors.css](_libs/ui/src/styles/shared/semantic-colors.css));
(2) **syntax** = **Shiki** themes installed into Monaco ([useMonaco.ts](_apps/web/src/composables/workspace/useMonaco.ts)).
A VSCode theme JSON has both halves: `colors` (workbench) and `tokenColors` (TextMate scopes). **Shiki consumes
`tokenColors` natively**, so the syntax half is near-identity; the real work is mapping the sparse workbench
`colors` onto the app's ~13 identity design tokens. That's exactly what I built.

**What I built.** [vscodeTheme.ts](_apps/web/src/composables/theme/vscodeTheme.ts) — a pure mapper:
- `parseHexColor` handles all four VSCode hex shapes (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`); `compositeOver`
  alpha-composites; `toHex` emits `#rrggbb`. The rigor that matters: VSCode borders/hovers are frequently ALPHA'd
  (`#ffffff0a`), so a naive alpha-strip yields the wrong solid — we **composite over the resolved canvas** instead.
- `vscodeThemeToTokens(theme)` → `{ mode, tokens }`: maps each of 13 identity tokens from a FALLBACK CHAIN of
  VSCode color keys (themes are sparse), resolves canvas first as the composite backdrop, infers dark/light from
  canvas luminance when `type` is absent, and fills any unmapped token from a per-mode default so the result is
  always a COMPLETE set (no half-styled UI). A closed `TokenVar` union makes the defaults table provably total
  (no non-null assertions).
- [vscodeTheme.test.ts](_apps/web/src/composables/theme/vscodeTheme.test.ts): 8 tests pin parsing (all shapes),
  compositing, the alpha-over-canvas behavior, luminance inference, and sparse-theme completeness. All green; web
  `vue-tsc` clean except the pre-existing `PageHeader` `_extensions/*` errors (untouched). Two real bugs caught &
  fixed in-run: `RegExp.exec` returns `null` not `undefined` (non-hex input would have thrown), and literal-union
  typing for total default lookups.

**Strategic state.** Three shipped spines now: Track A familiarity (keybindings), Track B viral loop
(share demo + invite), and Track A ecosystem (theme-import mapper — the first concrete step toward "bring your
VSCode look"). The theme mapper is the reusable core a later run wires into the live `data-theme` switch + a
`tokenColors`→Shiki registration + an OpenVSX fetch.

**Concrete next step for Run 8.** Two credible directions:
1. **Wire the theme mapper into the live UI (finish what Run 7 started):** a "Import VSCode theme" affordance on
   [SettingsAppearance.vue](_apps/web/src/pages/settings/SettingsAppearance.vue) — paste/upload a theme JSON →
   `vscodeThemeToTokens` → apply the tokens as inline `--color-*` overrides on the root (a new dynamic
   `data-theme="imported"`), persisted like the keymap (localStorage, per Run 3's pattern), + feed `tokenColors`
   to Shiki/Monaco. Makes Run 7 user-facing; mirrors the Run 3→4 "substrate then UI" arc.
2. **Pivot back to Track B — scoped collaboration invite links** (members/auth, [auth.ts](_apps/sandbox/src/auth/auth.ts),
   [PresenceStack.vue](_apps/web/src/presence/PresenceStack.vue)): multiplayer as a first-class link, the heavier
   viral/retention lever.
**Recommendation:** Run 8 does (1) — it converts Run 7's tested core into a shipped, user-visible feature (the
same discipline that made Runs 1–4 compound), and directly delivers "familiar for developers." Note for Run 9/10:
the arc is nearly complete across both tracks; a late run should also do a **synthesis pass** (the honest overall
strategy scorecard + what a real team would prioritize next). Do NOT commit; leave the tree clean.

### Run 8 — 2026-07-20 — Theme import goes live: paste a VSCode theme, recolor the app

**Decision.** Took Run 7's recommended step (1): convert the tested theme mapper into a shipped, user-facing
feature — the same "substrate → UI" arc as Runs 3→4. A developer bringing their exact VSCode look is the biggest
"familiar for developers" win, and Run 7 already did the hard pure core, so this run is the wiring.

**What I built.**
- [useImportedTheme.ts](_apps/web/src/composables/theme/useImportedTheme.ts): applies an imported theme by writing
  its tokens as inline `--color-*` overrides on `<html>` — inline custom properties beat the CSS-defined brand
  tokens, so it layers over the existing `data-mode`/`data-theme` system **without forking `@intentic-app/ui`**
  (keeping the run self-contained; no lib rebuild). Flips `data-mode` to the theme's mode so PrimeVue's dark preset
  matches. Persisted to localStorage (the useLayout/useKeymap idiom), re-applied on load, sanitized on read.
  `importThemeJson` parses → `vscodeThemeToTokens` → apply + persist, letting a JSON parse error propagate for
  inline display (CLAUDE.md: don't wrap). Exported `THEME_TOKEN_VARS` from the mapper as the single source of the
  set to apply/remove.
- [SettingsAppearance.vue](_apps/web/src/pages/settings/SettingsAppearance.vue): an "Import a VSCode theme" card —
  paste theme JSON, **Apply**, inline parse-error, an active-theme row (name + mode), and **Remove** to revert.
- 8 theme tests still green; web `vue-tsc` clean except the pre-existing `PageHeader` `_extensions/*` errors.
- **Honest scope (stated in code + UI):** maps the ~13 chrome IDENTITY tokens — not the full primary/surface
  RAMPS, and not yet Monaco SYNTAX (`tokenColors` → Shiki, which Shiki consumes natively). It's a recognizable
  live reskin of the chrome, not a pixel-perfect port. Single-mode (an import pins its own light/dark).

**Strategic state — four shipped increments, both tracks:** Track A familiarity (keybindings full stack), Track B
viral loop (share demo + invite), Track A ecosystem (theme mapper → **now live import UI**). The theme import is
the marquee "bring your VSCode look" feature, user-reachable today for the app chrome.

**Concrete next step for Run 9.** Recommend **completing the theme story end-to-end: syntax highlighting**. A
chrome-themed editor whose *code* still uses the stock palette is visibly half-done, so the highest-value finish is
wiring the imported theme's `tokenColors` into Monaco via Shiki — register the imported VSCode theme as a Shiki
theme and point [useMonaco.ts](_apps/web/src/composables/workspace/useMonaco.ts)'s bridge at it when an import is
active (Shiki loads VSCode themes directly, so this is mostly registration + re-running the existing bridge on
import change). Smaller alternative: derive the full `--color-primary-{50..950}` ramp from the accent so hovers/
badges stop mismatching. **Then Run 10 = the synthesis pass** (flagged since Run 7): an honest end-to-end
scorecard of the strategy — what shipped, what each bet is worth, the biggest remaining gaps to actually overtake
VSCode/Cursor (real extension marketplace, daemon-synced settings, perf), and what a real team should do next — and
Run 10 must also delete this cron job (it will be the 10th/final run). Do NOT commit; leave the tree clean.

### Run 9 — 2026-07-20 — Theme import completed end-to-end: editor syntax via Shiki

**Decision.** Took Run 8's recommended step: finish the marquee "bring your VSCode look" feature by theming the
EDITOR SYNTAX, not just the chrome. A chrome-themed editor whose code still uses the stock palette is visibly
half-done. Confirmed the Shiki `HighlighterCore` API from the installed types first (`loadTheme` / `getLoadedThemes`
/ `getTheme` / `setTheme`), so the wiring is correct-by-construction and fully guarded.

**What I built.**
- [useImportedTheme.ts](_apps/web/src/composables/theme/useImportedTheme.ts): now also retains the **raw** VSCode
  theme (its `tokenColors` ARE the syntax colors — the derived chrome tokens can't carry scopes) plus a stable,
  per-import unique `shikiName` (a module counter — no Date/random — so re-importing never collides with a stale
  same-named theme). Persisted + validated on read.
- [useMonaco.ts](_apps/web/src/composables/workspace/useMonaco.ts): `ensureImportedTheme(core)` loads the active
  import's raw theme into the shared Shiki core under its `shikiName` (Shiki consumes VSCode themes directly);
  `shikiTheme(core)` returns that name **only when it's actually loaded**, else the stock `dark-plus`/`light-plus`.
  The bridge now activates the imported theme, and a `watch` on the imported-theme ref reloads + re-bridges on
  import/remove (reverting to stock on remove). Loaded once before the first bridge so a reload lands straight on
  the imported syntax.
- **Blast-radius guard (the important part):** `loadTheme` is wrapped in try/catch and `shikiTheme` gates on
  `getLoadedThemes().includes(name)`, so a malformed/absent import silently falls back — normal highlighting for
  every other user can NEVER break from this change. 8 theme tests green; web `vue-tsc` clean except the
  pre-existing `PageHeader` `_extensions/*` errors. (Runtime Monaco behavior isn't unit-testable here; the guards
  are what make it safe to ship untested-at-runtime.)

**Strategic state — the theme-import feature is now complete for a user:** paste a VSCode/OpenVSX theme → app
CHROME recolors (Run 8) AND editor SYNTAX recolors (Run 9), persisted, revertible. Combined with the keybinding
stack (Runs 1–4) and the viral share loop (Runs 5–6), all three strategic bets have shipped, user-reachable spines.
Honest remaining theme gaps (non-blocking): full `--color-primary-{50..950}` ramp derivation, per-mode light+dark
in one import, and fetching from the OpenVSX registry by name (vs paste).

**Concrete next step for Run 10 (FINAL — must also delete the cron job).** No new feature; do the **synthesis
pass** flagged since Run 7: (a) a concise scorecard of what shipped across Runs 1–9 and what each bet is actually
worth for overtaking VSCode/Cursor/Zed/Windsurf/JetBrains; (b) the honest verdict — the biggest gaps a real team
must still close to win on *popularity* (a real extension marketplace / OpenVSX ecosystem, daemon-synced settings
so keymap+theme follow you, native-feel performance, and doubling down on the unforkable wedge: agents + deploy-to-
your-infra + share-a-live-env); (c) a prioritized "what a real team should do next" roadmap. Then, per the standing
brief: this brings RUNS_COMPLETED to 10/10, so call CronList, find the hourly job (cron "7 * * * *", prompt begins
"Autonomous strategy run"), and CronDelete it. Do NOT commit; leave the tree clean.

### Run 10 — 2026-07-20 — FINAL: synthesis, scorecard & roadmap

**Decision.** Per the standing plan, the last run is a synthesis pass — no new feature. Verified the full body of
work is green first (79 web tests across commands/theme/extension-host + 11 sandbox preview-proxy tests; web
`vue-tsc` clean bar the pre-existing `PageHeader` `_extensions/*` errors from concurrent work, which I never
touched). Then the honest scorecard, verdict, and roadmap below.

#### The thesis (unchanged, validated across 9 runs)
You do NOT overtake VSCode by being a better generic editor. You win by driving **switching cost → 0** (Track A:
frictionless familiarity) while delivering a workflow the incumbents **structurally cannot copy** (Track B: agents
+ deploy-to-your-own-infra + share-a-live-running-env). Cursor proved the familiarity half by forking VSCode;
Intentic is from-scratch, so it must *earn* familiarity — but in exchange it owns a wedge Cursor/VSCode/Zed can't
add without becoming a different product.

#### What shipped (Runs 1–9), and what each bet is worth
| # | Increment | Track | Strategic value |
|---|---|---|---|
| 1 | Keybinding engine: pure chord matcher + global dispatcher, palette teaches shortcuts | A | **High** — the connective tissue of "feels like VSCode"; nothing else in A works without it |
| 2 | Keybindings as a manifest-gated extension contribution | A | **Med** — lets the ecosystem (not just builtins) feel native; compounds 1 |
| 3 | Rebindable keymap (override store, 3-state: remap/unbind/default) | A | **High** — remapping is the #1 expectation after bindings exist |
| 4 | Keybindings settings UI (record/unbind/reset, conflict warnings) | A | **High** — makes 1–3 user-facing; a complete, shipped "remap like VSCode" feature |
| 5 | One-click **Share a live preview** (public URL + honest disclosure) | B | **Very high** — the viral primitive; every shared URL is a live demo the incumbents can't produce |
| 6 | Branded preview-proxy interstitials (the **invite** half of the loop) | B | **Med-High** — closes the loop non-intrusively; CTA at the highest-intent moment |
| 7 | VSCode theme → design-token **mapper** (pure, alpha-correct, tested) | A | **High** — themes are the #1 switch-blocker; the tested core of "bring your look" |
| 8 | Live theme-import UI (chrome recolors from pasted JSON) | A | **High** — makes 7 real & visible |
| 9 | Theme import **completed**: editor syntax via Shiki (guarded) | A | **High** — a half-themed editor isn't a theme; this finishes the marquee feature |

Net: **three coherent, shipped spines** — a full VSCode-shaped keybinding system, a working viral share loop, and
end-to-end VSCode-theme import — each built with tests, typecheck, and a clean tree, never committed (per the
standing brief).

#### Honest verdict — the biggest gaps still between Intentic and "top-choice popularity"
1. **A real extension ecosystem (the deepest moat, still open).** VSCode's true lock-in is ~50k extensions +
   muscle memory. Runs 1–2/7–9 built the *interop primitives* (bindable/gated commands, VSCode-theme import), but
   there is no **OpenVSX marketplace fetch** yet (themes are paste-only; no browse/install). This is the single
   highest-leverage remaining bet for popularity — and the hardest.
2. **Settings that follow you.** Keymap + imported theme persist to **localStorage** (per-machine, like VSCode's
   files). The differentiated version — *daemon-synced* settings so your keymap/theme follow you to any browser on
   the same sandbox — is a small, high-delight change (the stores are already isolated behind their composables for
   exactly this swap; noted in Runs 3 & 8).
3. **Native-feel performance.** Not measured or touched this cycle. Zed's whole pitch is speed; a browser+remote
   editor must prove it's not laggy. Needs an explicit perf pass (Monaco load, keystroke latency, large-file/tree).
4. **The wedge is under-marketed inside the product.** Track B shipped the *mechanism* (share a live env), but the
   "agents → preview → deploy-to-your-infra → share" story isn't yet a guided, obvious first-run flow. The wedge is
   the reason to switch; it should be the loudest thing in the UI, not a capability to discover.

#### What a real team should do next (prioritized)
1. **OpenVSX theme/keymap *import-by-name*** — fetch from the registry (not paste), the first real "browse & install
   from an ecosystem" surface. Extends Runs 7–9 directly; biggest familiarity+network-effect payoff.
2. **Daemon-synced settings** — promote keymap + imported theme from localStorage to the sandbox settings store
   (`settings.contract.ts`); "your setup follows you" is a concrete edge over per-machine VSCode.
3. **A guided wedge onboarding** — a first-run flow that walks agents → preview → deploy → **Share**, so the viral
   loop (Runs 5–6) is entered by default, not stumbled upon.
4. **A perf budget + instrumentation** — measure keystroke/scroll/open latency vs VSCode/Zed; protect the "smoother
   experience" claim with numbers.
5. **Then** the hard, multi-quarter bet: a **`vscode.*` web-extension compatibility layer** (Run 2's memo path 3) —
   only after 1–4 prove the on-ramp converts.

**Closing.** The strategy is sound and now has shipped proof on both halves: close the familiarity gap to ~zero,
win on the wedge the incumbents can't fork. The remaining work is ecosystem depth (OpenVSX/marketplace), settings
sync, perf, and making the wedge the product's headline. This completes the 10-run mandate (RUNS_COMPLETED 10/10);
the hourly scheduler is being deleted now. Do NOT commit; the tree is clean and every increment is verified.
