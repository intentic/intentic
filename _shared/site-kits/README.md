# site-kits

One site's whole job in one tool call (ChatGPT's, so far), written once behind a host interface any browser can implement.

A site kit replaces the twenty fragile page-tool calls an agent would make on a busy site with one call that knows the
site: which elements to use, what "done" and "failed" look like, and how long the site takes. This package holds
everything that does not depend on which browser runs it, so each host answers an agent in exactly the same words. There
are two: the browser extension (`_devices/webext`, the person's own Chrome, `chrome-host.ts`) and the sandbox's own
signed-in Playwright browsers (`_sandbox/sandbox`, `browser/tools/chatgpt-host.ts`, listed by the `browser` router for an
account signed in on chatgpt.com).

- **ChatGPT** (`src/chatgpt/`): `chatgpt_send`, `chatgpt_read` and `chatgpt_image`. Every lookup and string ChatGPT's
  page is assumed to have is in `site.ts`, each marked as seen in a real snapshot or guessed; a redesign is fixed
  there. The steps that run inside the page (`page-hands.ts`, `steps.ts`, `project-steps.ts`) are each handed to a
  host alone, as a function and JSON arguments, so each is self-contained and shares state only through the helpers
  the four installers put on the page's window. The engine (`engine.ts`, `project.ts`) opens or reopens a chat in
  the sandbox's own ChatGPT project, chooses a mode, attaches files, sends one prompt and watches the answer in
  rounds; `answers.ts` and `image.ts` word what the agent is told, and `tools.ts` holds the tool descriptions and
  inputs.
- **The host** (`src/chatgpt/host.ts`) is everything a browser does differently: its gates, the page a call works in,
  running a step, files, saving, and what it keeps between calls. All tab and window bookkeeping is the host's, so the
  engine never sees one. The comment at the top of that file says what each member means for the extension and for
  the sandbox's browser. Neither host presses ChatGPT's own confirmation buttons: the engine reports that ChatGPT is
  waiting on the person, and the host's `voice.asking` adds how the person comes to see that page (nothing in the
  extension, whose tab is in front of them; the accounts tools' `request_help` in the sandbox).
- **Running a step.** The extension injects each helper and the step into Chrome's isolated world, where the helpers may
  stay. The sandbox's browser has only the page's own world, so it sends ONE `browser_evaluate` per step whose function
  installs the helpers, calls the step and runs `cleanup` before the step's first wait: each step reads the helpers
  synchronously at its start, which is what lets them leave the window at once.
- A refusal is a `KitRefusal` (`src/host.ts`), whose message is what the agent reads; each host turns it into its own
  refusal. The engine imports nothing from any host.

## Key files

- [src/chatgpt/host.ts](src/chatgpt/host.ts) — the interface a browser implements to run the ChatGPT kit, and what each member means for each host.
- [src/chatgpt/engine.ts](src/chatgpt/engine.ts) — the chat itself: gates, opening or reopening a chat, sending, the watch in rounds, remembering chats.
- [src/chatgpt/site.ts](src/chatgpt/site.ts) — everything the kit assumes about ChatGPT's page: the first place to fix after a redesign.
- [src/chatgpt/steps.ts](src/chatgpt/steps.ts) — the steps that run inside ChatGPT's page, one per call, on the helpers `page-hands.ts` installs.
- [src/chatgpt/tools.ts](src/chatgpt/tools.ts) — the three tools' descriptions and inputs, the same for every host.
- [src/chatgpt/fake-chatgpt.testing.ts](src/chatgpt/fake-chatgpt.testing.ts) — a stand-in ChatGPT page in jsdom, exported as `./chatgpt/testing` for both hosts' own suites.
