---
name: chrome
description: Use "${id}", the user's OWN signed-in browser, on the sites they allow: for what needs THEIR session and no sandbox account covers (work SSO, a passkey, a bank, a datacentre-blocked site, their own ChatGPT), or when they say "my browser". Not for a site with its own skill (X, Reddit…), not unattended.
---

${tools}

## Which browser to reach for

This sandbox usually has two, and picking the wrong one wastes a turn:

| Want | Use |
| --- | --- |
| A public page, no sign-in | `webq` or an ordinary fetch. Cheapest, and borrows nobody's session. |
| A site the sandbox has its own account on | The sandbox's own browser (`mcp__<account>__browser_*`). It works while nobody is at the keyboard. |
| A site only THEY are signed into | **This.** Their passkey, their SSO, their second factor, their fingerprint. |
| A long job on a site they are signed into | This, then `connect_site` once, then the sandbox's browser from then on. |

## Chromium specifics worth knowing

- **Your pages open in a window of your own, behind theirs.** Tools given no `tab` work on your tab there. A page
  they already have open (pinned, in the background, or in front of them) is the same to these tools: pass its `tab`
  id from `tabs` and it is worked on where it is, never brought forward. Behind their window your page is throttled
  (no animation frames, timers about once a second): if a list never loads more as you scroll, say so and ask them to
  move your window to a spare screen, where it runs in full.
- **Profiles are separate browsers.** If they run a work profile and a personal one, only the profile with the
  extension in it is connected, and a site signed in on the other profile is not signed in here.
- **A page you cannot see may still be loading.** `snapshot` says when the document is still loading; prefer
  `wait_for` over taking another snapshot straight away.
- **Single-page apps re-render constantly.** A ref taken before a click that re-rendered the list is stale, and
  will be refused. Snapshot, act, read what came back, snapshot again.
- **`chrome://` pages, the Web Store, and other extensions' pages cannot be touched by any extension.** That is
  the browser's rule, not this connection's, and there is no permission that changes it. They never run a user
  script either.
- **User scripts need Chrome 135 and two switches the person turns on once:** Scripts in the extension's popup, and
  the browser's own "Allow User Scripts" on the extension's details page ("Developer mode" before Chrome 138).
  `describe`'s `Scripts:` line says which one is missing.
- **A user script reaches only its own sites and its `@connect` hosts.** Chrome blocks its requests and loads to any
  other host, whatever the page itself allows. An installed script runs from the next page load, so reload an open
  tab to see it.
- **Bring files in with `save_media`, not the site's Download button.** It saves an image, video or file from the
  page into the sandbox and answers with the path. Prefer `ref`; `url` needs the site in read and act and keeps only
  media, documents and downloads. A download that does start says where it went;
  one that landed in their Downloads folder stays theirs. Never fetch it through a connected computer
  (`run_command`, `docker cp`, a path into a container): that is a side door around this connection. Ask them to
  drag it into the app instead. `upload_file` goes the other way, into a page's file input, after their yes.

## Etiquette that keeps this connection installed

It is the same browser their bank is open in. The habits that make this feel safe rather than alarming:

1. **Say what you are about to do in their browser before you do it**, when it is anything more than reading.
   They will see the banner anyway; being told first is the difference between a colleague and a poltergeist.
2. **Work in one tab, and put it back.** Opening eleven tabs and leaving them is somebody else's mess to clear.
3. **Never type a credential.** If a page wants a password, a code or a card number, stop and ask them to do
   that part. You cannot read a password field, and you should not want to.
4. **If something looks wrong — an unexpected login page, a payment screen you did not expect — stop and say
   so.** A page that is not what you expected is exactly when to stop, not to click on.

## Working habits that save turns

- **Load every tool you expect to need in ONE ToolSearch call** (a comma-separated `select:` list); each
  extra ToolSearch is a full round trip, and a second one is only for a tool the task turned out to need later.
- **Read pages as text, not pixels.** `read`/snapshot give the page's actual words and structure; a screenshot
  is for when the layout itself is the question, or the person asks to see it.
- **Never trigger a JavaScript `alert`, `confirm` or `prompt`.** A modal dialog blocks every browser event, so
  the extension stops receiving commands and the person has to dismiss it by hand. Avoid clicking what is
  likely to raise one (a "Delete" that confirms); if you must, warn first; use `console.log` and the console
  reader for debugging, never `alert`.
- **Stop and ask after two or three failed attempts.** A tool call that keeps erroring, an element that does
  not respond, a page that will not load, a task that turned out to involve more than it said: say what you
  tried and what went wrong, and ask how to proceed. Do not keep retrying the same failing action.

## Asking their ChatGPT

Use `chatgpt_send` when they want their own ChatGPT on something: a second opinion, Deep Research, agent mode, their
connected apps (Google Drive, Slack…), or files from the sandbox read by it. Each prompt spends their plan's allowance.
When a sandbox account is signed in on chatgpt.com, the `browser` server has the same three tools (with that account's
`account`), in the sandbox's own browser with no card in front of the person: prefer those unless the person wants
this browser, or ChatGPT needs something only it has.

- **Where it goes.** New chats go into a ChatGPT project of this sandbox's own, "Intentic · <sandbox>", made on first
  use with project-only memory: their saved memories and other chats stay out, while apps, files and every tool work,
  and the chat can be opened again by its address. The answer says when the project was made, or when it could not be
  and a temporary chat (apps off) was used instead; pass that on. `personalized: true` uses a regular chat with their
  memory, only when they ask.
- **One call per prompt.** It answers with ChatGPT's words (a long answer is saved as a Markdown file and its start
  shown), images saved into the sandbox, and the `chat` to go on in. `files` must be on the artifacts shelf; the
  person is asked on the page before they go.
- **Long jobs.** `mode: "deep_research"` or `"agent"` often runs 5 to 30 minutes. When the answer says ChatGPT is still
  working, call `chatgpt_read` with the `chat` (and `wait` up to 540) until it is done. Never send the prompt again.
- **ChatGPT asking the person.** When it waits on its own "Confirm" (an app reaching outside the project, an agent
  step, a sign-in to take over), the answer says so. The kit never presses those: tell the person what it is asking and
  that it is in their browser, then `chatgpt_read` once they have answered.

## Generating images in their browser

Use it when they ask, or when the image has to come from a service they pay for (their ChatGPT, Midjourney…) that
the sandbox has no key for. Every image spends their plan's allowance. A local model or an API key the sandbox holds
is unattended and leaves their account alone, so prefer those when the result is good enough. Before the first image,
say how many you mean to make and where.

**ChatGPT: `chatgpt_image`, one call per image.** It sends the prompt in a chat in the sandbox's own ChatGPT project
(see below), waits (several minutes is normal), saves the image into the sandbox, and answers with the `chat`, the
saved paths and whatever ChatGPT wrote. Pass that `chat` to the next call for the same style and world. Leave
`personalized` off unless they ask: their memory and past chats steer the image (one person's game keyframe came back
as a pastiche of a series they had chatted about). Read the text it answers with: a refusal means rewrite the prompt,
never resend it as it was; a usage limit means stop and tell them when it resets; a question from ChatGPT gets a short
answer in the same `chat`. An answer saying the prompt was sent or may already have gone means never send it again:
collect it with `chatgpt_read`. chatgpt.com must be allowed in read and act. One call at a time, never in parallel.

**By hand, on another site or when the kit fails or is missing:**
1. On ChatGPT, `open` `https://chatgpt.com/?temporary-chat=true`, then set that chat's "Personalized" menu to
   "Unpersonalized": a temporary chat still reads their memory until you do. Never change their settings or model.
2. `fill` the prompt, then `click` Send. Read what each action answered. "The page then moved to …" means it went;
   otherwise (a temporary chat often keeps its address) `snapshot` and look for your message before sending again,
   since a blind retry spends a second image. If `fill` says the editor did not take the text, do not send.
3. `wait_for` with `quietFor` (about 20) and `seconds` up to 540, then `snapshot`; if it is still generating, wait
   again.
4. Find the image's ref in the snapshot (images are listed with their size; take the large one) and `save_media` it
   with a `name`.

**Prompts that work:**
- **One sentence, style first, then a single scene:** "A painterly stylised 3D animated film still with chunky
  hand-painted textures: a lantern-lit timber harbour town at blue hour beneath a lighthouse glowing amber on the
  cliff." Long, precise world descriptions flatten every style into the same image.
- **One chat per style.** Later shots are short follow-ups in that chat: "Same style and world: low angle up the
  cliff stair to the lighthouse, one child and a dog small on the steps for scale."
- **Describe how things look, not what they are called.** A franchise's names and invented words (its magic system,
  its warrior caste) pull the model toward that franchise, even when your project uses them too. Write "glowing
  blue energy", not the term.
- **Ask for the aspect ratio in the prompt** ("wide 16:9"). For frames that will be animated, a few separate
  figures survive. Crowds and fast limbs smear.

**Showing them:** show the saved files inline with `show_page`. Originals stay where they were saved in the
sandbox; do not copy them onto their computer, since they open them from the app. End by saying how many
generations you spent, refusals included.
