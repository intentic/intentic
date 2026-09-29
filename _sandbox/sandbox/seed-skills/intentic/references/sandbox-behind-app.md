# "Your sandbox is older than the app": a common cause of odd errors

## Why it happens

The app at app.intentic.dev updates itself: it checks its own build every 15 minutes and offers a reload. The
sandbox daemon updates only when its owner updates it. So a page newer than the daemon it drives is the normal
case, and the one app talks to daemons of many versions at once. When the sandbox connects it tells the page
which routes it has, with a fingerprint of each one's shape; the page hides what an older daemon lacks, and where
a call still lands on a gap it says so in words:

| The owner sees | Means |
|---|---|
| This sandbox's daemon doesn't provide '<route>'. Update the sandbox to a newer image to use this feature. | the daemon predates that route |
| This sandbox's daemon has '<route>' but exchanges different fields for it than this app expects. … | same route, different shape |
| This sandbox answered in a shape this app doesn't expect. Reload this page, or update the sandbox to a newer image. | the page could not read the answer; either side may be older |
| This page is running older code than the sandbox: reload the page. | the page is the older side; a reload fixes it |
| This sandbox's daemon didn't keep <field>. Update the sandbox to a newer image to use it. | a setting saved but not stored: the daemon predates it |
| **This sandbox runs an older version** / **Update the sandbox** | a view needs a route the daemon lacks |
| On Sandbox ▸ Overview: **Your sandbox is older than this page**, **This page and your sandbox are from different versions**, **This page and your sandbox are far apart**, **Some parts of this page may not work** | the version card, listing each part of the app as not available, may misbehave or not used yet |

A blank or failing panel, a button that does nothing, or a setting that snaps back can be the same gap without
those words.

## Check before blaming the browser

A hard reload or a cleared cache fixes only the case where the page is the older side. Check the daemon first:

1. `/opt/sandbox/package.json`, field `version`: the daemon's release. `0.0.0` is an unreleased build (a source
   checkout or a CI image): it never checks for updates, and the Update card calls it **Built from your checkout**
   and offers **Take the published image instead**.
2. `echo $SANDBOX_IMAGE`: the image this sandbox runs.
3. The newest release: `tag_name` of `https://api.github.com/repos/intentic/intentic/releases/latest`. The Update
   card offers a release once the same image is also published as `ghcr.io/intentic/sandbox:stable`.
4. `mcp__diagnostics__errors` with `source: "browser"`: what the page reported about itself, each event with the
   page's build. Search it for "doesn't provide", "didn't keep" or "answered in a shape".

Say what you found: the daemon's version, the newest one, and the message that names the gap.

## How the owner updates

Sandbox ▸ Overview shows **Installed version** and, when one is out, **→ <version> available**, with the Update
card:

- **Hosted**: **Restart and update**, "the platform boots your sandbox onto the new image, files kept".
- **On their own machine**: **Update now** (or **Download only** first), which runs on a connected device or in the
  desktop app, and otherwise shows the command to run on that machine. `ic sandbox update <slug>` on the machine
  itself does the same.

The sandbox restarts for about half a minute; files in `/work` and conversations are kept. Running turns stop
(the card warns when an agent is mid-turn) and must be resumed unless **Resume turns after a restart** is on, or the
owner left the dialog's **Let them pick up again by themselves** ticked for that restart. An
agent never updates or restarts the daemon itself: it is the owner's press, and it would end the agent's own turn.
