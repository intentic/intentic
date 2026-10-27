# The editor, in the owner's words

The app is **https://app.intentic.dev**, from any browser or phone (Add to Home Screen installs it). Its first screen
is **Home** (`/home`): every sandbox the person has, at once. Going into a sandbox lands on its **Agents** board.

- **Chat** (`/chat`): one conversation, docked beside the other views on a desktop and opened full screen at `/chat`;
  on a phone a conversation is its own screen under its card (`/agents/<id>`). Question cards (`AskUserQuestion`),
  plan approval, capability asks and payment approvals render here. Each session card shows a badge for what its last
  turn showed of its own work.
- **Pages in chat**: `mcp__ui__show_page` draws a self-contained HTML page inline (a chart, a table, a mock-up), in the
  chat's own theme; `mcp__ui__ask_page` draws one as a card and waits for what the page sends back with
  `window.intentic.submit(value)`. Pages run sealed: scripts yes, network no. Files they name on disk and libraries on
  the usual CDNs (jsDelivr, unpkg, cdnjs, d3js.org, cdn.plot.ly, the Tailwind CDN, jQuery's, Google Fonts) are carried
  in when the page is shown; anything else does not load. `check: true` lays the page out headless first, in a frame
  like the chat's, and returns a picture and its console. What a page's scripts throw in your chat is told to the agent
  while the turn that showed it runs; after that, the page's caption offers **Ask to fix**, which fills the composer. A
  page's button can put words in the composer (`window.intentic.send`), never send them. Each page is a file under
  `.intentic/records/artifacts/pages/<conversation>/`; its caption opens it full size or publishes it to the outbox. A
  connected MCP server's own app (an MCP Apps `ui://` resource) is drawn the same way after a call to its tool. The
  owner can switch all of it off (Sandbox ▸ Agent ▸ Tools ▸ **Pages in chat**).
- **Code review in chat**: a harness's own reviewer draws its findings as one card in the chat: Claude Code's
  `/code-review [low|medium|high|xhigh|max]`, Codex's `/review [branch <name> | commit <sha> | what to look at]`. Each
  finding opens its file at the line, and **Fix** (one, or all) writes the ask into the composer. OpenCode's `/review`
  answers in prose. Typed in an agent's own chat, the review reads that chat too, so it is the agent checking itself.
- **Fresh sessions on an agent's work**: an agent's card menu (**Fresh session on this work** ▸ Code review, Test, Own
  ask) and its page's session menu open a new chat on that agent's work as it is now, with none of its conversation, so
  a review or a test judges the result rather than the reasoning (the way Claude Code's and Codex's own reviewers run).
  None of them is required. A strip over the composer names the work and switches what the chat is for; the ask stays
  editable until you send it. The new chat hangs under the agent's card with a kind tag, and its edits go back into that
  agent's work. Its findings never reach the agent by themselves: in the review card, **Fix in the original** puts them
  in the agent's own composer, where you press Send. A card's corner carries one stamp per check that ran on its work:
  its own last check (**Self-check**: passed after last edit, or last run failed), then the latest of each kind run on
  it (**Code review**: 3 findings open, **Test**: done), marked "work changed since" with **Again** once the work moved
  past it. Pointing at the stamps says each in words. A check that never ran says nothing, and none of them is a gate.
- **Agents** (`/agents`): the fleet board, every conversation as an agent with its branch and status. Every agent a
  conversation started hangs under its card as a row, whichever way it was started, and the chat's list of open chats
  hangs the same rows under its cards: a conversation it spawned (its row opens its own chat) and a subagent its runtime
  ran in-process (its row shows that subagent's own transcript in the parent's chat). Either way the chat is read-only:
  a bar stands where the message box would, naming the parent and leading back to it, since the parent directs its
  subagents; a spawned one can still be written to directly from the bar. A spawned child's code goes back into its
  parent's checkout, as an in-process subagent's edits do, so the family lands once, with the parent. **Land** (in plain
  words, **Accept**) applies a conversation's delta to the main tree; a conflict card names the paths. Cards carry
  titles, reactions and a tint for the kind of work, never tags (`agents-board.md`). With geek metrics on (Settings ▸
  Appearance), the status bar carries the sandbox's CPU, memory and disk, and opens a panel with every figure, memory by
  kind of process, and memory and CPU by session; each card shows its own conversation's. Desktop only: a phone shows
  no geek metrics.
- **Status bar** (the foot of the desktop window): what the sandbox is running, not places. The terminal's toggle
  (Ctrl+`, developers only), then chips that are there only while live: **Browsers**, one chip for the live apps while
  something answers, the agents' open browsers and the sandbox's desktop while a window is open (amber while an agent
  waits on you in one); a port open to the internet (amber); a connected VPN. Each chip opens its page. Nothing running
  means no chip: the palette still reaches Browsers, the live app and the desktop.
- **Pipelines** (`/ext/pipelines`, a rail tile shown once a GitHub or GitLab account is connected, counting the
  branches whose last commit fails): the workspace repositories' CI runs, each run's jobs drawn as a graph, with rerun,
  cancel and Fix. A failing main-line branch shows above the runs with the one fix agent on it and what was last decided
  about it: the agent has it, it waits for you, or it is only reported because **Repair main when its CI fails**
  (Sandbox ▸ Agent ▸ Finishing) is off. Nothing checks a push on its way out: what a push broke is CI's to say, and on
  main the fix agent takes it (`checks-and-ci.md`).
- **Capabilities** (`/capabilities`): the connections; each card is a connector, account, device or service.
  **Devices** (`/devices`): the machines this sandbox reaches. The account's recently deleted sandboxes are a page of
  the account's (`/deleted-sandboxes`), linked at the foot of the sandbox switcher and Home while one can come back.
- **Sandbox** (`/sandbox/<tab>`): Overview (version, update, Sandbox URL), Usage, Models (every account, subscription,
  local model and endpoint it can run on), Agent (`?section=` jobs, instructions, tools, finishing), Environment,
  Secrets, Extensions (finding and installing them too), Access (`?section=` people, profiles, areas, sign-in, programs,
  allowed), Personas, Map (who gets in and everything the sandbox reaches, on one drawing), Privacy & safety (tabs: Data
  protection, Privacy shield, Guardrails, Retention), and Activity (`?section=audit` for the audit log).
- **Workspace** (`/workspace/<path>`): the file tree, and the Changes panel where work is committed (**Commit**, or
  **Save N changes** in plain words). **Browsers** (`/browsers`): everything live the sandbox shows, as tabs: the
  agents' browser windows, the apps it serves, its desktop. **Settings** (`/settings`): the owner's own preferences, not
  the sandbox's, except Appearance ▸ **How you work**, git's words (**I write code**) or plain ones (**I don't**), which
  the sandbox keeps per person so all of their devices read the same words.

## Who changes what

Settings and config are the owner's to change from the editor (Sandbox ▸ Models, ▸ Agent, ▸ Secrets, ▸ Personas, ▸
Extensions, ▸ Environment, and the tabs of Privacy & safety: Data protection, Privacy shield, Guardrails, Retention).
Read them to answer questions; edit them only when asked to. What happened is Sandbox ▸ Activity, in tabs: turns,
commands the judge checked, what the shield masked, and the audit log of what people did.
