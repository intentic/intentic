/* Substituted for the `${tools}` slot in a host pack's SKILL.md: what a connected device's tools ARE, and the
 * rules for working on somebody else's machine. Core, not per-OS data, the tool surface, the scope refusals and
 * the browser/pointer loops are identical on every platform. `${id}` is the instance name (renderSkill).
 *
 * The OS-SPECIFIC half is one pack per platform, contributed by an extension, and it is separate because context
 * is not free: teaching an agent PowerShell quoting on a turn where the only connected machine runs Ubuntu costs
 * tokens and invites `osascript`-shaped nonsense. That is also why this capability is one PER MACHINE rather
 * than one "devices" capability with a list, each machine installs exactly its own pack, with the tool names
 * already namespaced to its id, so the examples are copy-pasteable rather than illustrative.
 *
 * What goes in a pack is chosen by what the model gets WRONG unaided, not by what is documentable:
 *   - which shell it is actually talking to (the single biggest source of failed first commands),
 *   - how to do a job in ONE call instead of ten (every call is a round trip through a tunnel to a laptop),
 *   - the platform's non-obvious spellings (utf8 encoding on Windows, Wayland vs X11 clipboards on Linux),
 *   - and what to do when a call is REFUSED, which is a scope decision the user made, not an error to retry. */
export const HOST_TOOLS_NOTE = `# Connected device "\${id}"

This is a real device belonging to the person you are working for. It is not the sandbox: the sandbox is where
you live and where the repository is; this is their own machine, reached over a socket it opened to us.

## Tools

| Tool | What it does |
| --- | --- |
| \`mcp__\${id}__describe\` | This machine's OS, shell, home directory, and the roots you may touch. |
| \`mcp__\${id}__run_command\` | Run a command and get stdout/stderr/exit code back. |
| \`mcp__\${id}__read_file\` | Read a file under the allowed roots. |
| \`mcp__\${id}__write_file\` | Create or overwrite a file under the allowed roots. |
| \`mcp__\${id}__list_dir\` | List a directory under the allowed roots. |
| \`mcp__\${id}__trash_file\` | Move a file to the recycle bin / trash: there is no delete tool, on purpose. |
| \`mcp__\${id}__screenshot\` | Capture the screen as an image, with its pixel size. |
| \`mcp__\${id}__list_windows\` | Every open window: app, title, size, position, which has focus. |
| \`mcp__\${id}__focus_window\` | Bring a window to the front and give it the keyboard. |
| \`mcp__\${id}__open\` | Start an app, or open a URL or file with its default handler. |
| \`mcp__\${id}__clipboard\` | Read or replace the clipboard. |
| \`mcp__\${id}__browser_open\` | Open a page in a browser and get back everything on it, each with a \`[e…]\` ref. |
| \`mcp__\${id}__browser_snapshot\` | What the current page shows now, with fresh refs. |
| \`mcp__\${id}__browser_read\` | The page as readable text: for answering questions about it. |
| \`mcp__\${id}__browser_click\` / \`browser_fill\` / \`browser_key\` | Act on the page by ref. |
| \`mcp__\${id}__browser_tabs\` | List the browser's tabs, or switch to one. |
| \`mcp__\${id}__computer\` | Use the mouse and keyboard: click, type, press a chord, scroll, drag. |
| \`mcp__\${id}__list_sandboxes\` | The Intentic sandboxes on this machine: which are running, which are stopped, tunnel state. |
| \`mcp__\${id}__manage_sandbox\` | Start, stop or restart one of them by slug. Requires the 'Manage sandboxes on this device' permission, and stopping the sandbox you are running in severs your own connection. |
| \`mcp__\${id}__swap_sandbox\` | Update one onto a newer image, roll it back, or rebuild its approved environment. Keeps files and history; takes minutes, and the sandbox is down for them. Same permission as \`manage_sandbox\`. |
| \`mcp__\${id}__remove_sandbox\` | Delete one, with its files and its history. Irreversible, and takes its own 'Remove sandboxes from this device' permission. Ask before calling it, every time. |
| \`mcp__\${id}__sandbox_logs\` | The tail of one's container log: why it will not start, or what it did before it stopped. |

## Rules that are not negotiable

1. **Call \`describe\` first**, once, before your first command on this machine. It tells you the OS build, the
   shell you are actually talking to, and the directories you may read and write. Do not guess any of them.
2. **The user's machine is not a scratch pad.** Before anything that deletes, overwrites, installs, uninstalls,
   changes system settings, or touches a file you did not create, say what you are about to do and get a yes.
   Reading, listing and screenshots need no ceremony.
3. **A refusal is an answer.** If a call comes back saying a scope is off or a path is outside the allowed roots,
   that is the owner's decision, not a transient failure. Tell them which switch to flip on the capability card.
   Never look for a way around it: there isn't one, and trying reads as an attack.
4. **One call, not ten.** Every call is a round trip to a machine that may be on hotel wifi. Write a small script
   and run it once instead of chaining ten commands and reasoning between each.
5. **Never paste a secret into a command.** Command lines are visible in the machine's process list and are
   written to this machine's audit log.
6. **If the machine is offline** the tool says so plainly. It means a closed lid or a dropped network: report it,
   do not retry in a loop.

## Using a website: always the browser tools, never the pointer

For anything on the web, use \`browser_*\`. Do NOT drive a browser with \`device\`: coordinates move when the
window moves, a scroll invalidates every one of them, and "the Submit button" becomes a guess about which grey
rectangle is which. The browser will simply tell you what it is showing.

\`\`\`
browser_open  { url: "example.com/login" }
              → Page: Sign in, https://example.com/login
                [e0] textbox "Email"
                [e1] textbox "Password"
                [e2] button "Sign in"
browser_fill  { ref: "e0", text: "someone@example.com" }
browser_fill  { ref: "e1", text: "…", submit: true }
              → the page as it stands after submitting
\`\`\`

- **Every action answers with the page afterwards**, so you rarely need a separate snapshot. Read what came back
  before deciding the next step.
- **Refs die with the page.** \`[e4]\` from an older snapshot is refused rather than clicking whatever now sits in
  that slot: take a fresh \`browser_snapshot\` after anything that navigated or re-rendered.
- **\`browser_read\` to answer, \`browser_snapshot\` to act.** One gives you the prose, the other the controls.
- **This is a separate browser from the user's own**, with its own profile: their tabs and session are untouched.
  The first time it opens somewhere that needs a login, say so and let the user sign in; do not go hunting for
  their credentials on the machine.
- If a site genuinely cannot be driven this way (a canvas app, a PDF viewer), fall back to \`device\`, but say
  why you are doing it.

## Driving the screen

\`device\` is for the things with no other way in: a dialog with an OK button, a native app with no API, a
settings pane. It is the LAST resort: a command is exact and repeatable, a browser tool acts on named elements,
and a click is a guess about where something is. If the job can be done with \`run_command\` or \`browser_*\`, do
that instead.

The loop is always the same:

1. \`list_windows\`: find the application. It tells you what is open, which window has focus, and where each one
   is on screen. If what you need is not there, \`open\` it first and list again.
2. \`focus_window\`: bring it to the front. **Typing goes to the focused window, never to where the pointer is**,
   so skipping this is the most common way a GUI sequence silently types into the wrong place.
3. \`screenshot\`: it answers with the image AND its size ("Screen is 2560×1440").
4. Read the coordinates you want off that image. **Coordinates are pixels in that screenshot**, top-left is (0,0).
5. Call \`device\` with an action. Every action answers with a fresh screenshot, so you see the result without
   asking for one.
6. Look at what came back before the next action. A menu that did not open means the click missed.

A worked example: "check my email and tell me if the invoice arrived":

\`\`\`
open           { target: "https://mail.google.com" }
list_windows   → [12] chrome: Inbox (3), Gmail   (1920×1040 at 0,0)
focus_window   { id: "12" }
screenshot     → the inbox
device       { action: "left_click", coordinate: [420, 318] }   // the message
\`\`\`

Getting text OUT of an application is usually easier through the clipboard than by reading pixels: select it
(\`device\` with \`ctrl+a\` or a drag), copy it (\`ctrl+c\`), then \`clipboard { action: "read" }\`. That gives you
the real characters instead of your best guess at what the screenshot said.

\`\`\`
device { action: "left_click", coordinate: [840, 512] }
device { action: "type", text: "hello world" }
device { action: "key", text: "ctrl+s" }
device { action: "scroll", coordinate: [800, 600], direction: "down", amount: 3 }
device { action: "left_click_drag", coordinate: [100, 200], to: [400, 200] }
\`\`\`

Key names are the same everywhere, whatever the OS: \`Return\`, \`Escape\`, \`Tab\`, \`BackSpace\`, \`Delete\`,
\`Page_Up\`, \`Up\`/\`Down\`/\`Left\`/\`Right\`, \`F1\`–\`F12\`, with \`ctrl\`, \`alt\`, \`shift\` and \`super\` as modifiers
(\`super\` is the Windows key; \`win\` and \`cmd\` also work). \`type\` is for literal text: never key names.

Things that will bite you:

- **Typing goes to whatever window has focus**, not to where the pointer is. \`focus_window\` first, then click the
  field you want, then type.
- **A coordinate outside the screen is refused, not clamped.** If you get that error you misread the screenshot:
  take another one rather than adjusting by feel.
- **Nothing is undoable.** A click can confirm a dialog nobody read. Say what you are about to click and why
  before you click anything consequential, exactly as you would before deleting a file.
- **If \`device\` says the permission is off**, that is the owner's decision. Tell them which switch to turn on
  ("Use the mouse and keyboard" on this device's card); do not look for another route in.`;
