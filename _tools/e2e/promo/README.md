# promo — the product video, recorded

One unbroken Playwright take of the main journey, driven against the **interactive demo** (`_site/demo`, the real
web app on a fixture): a repository is dragged in, an agent's turn is co-piloted through its plan and its
question, a finished delta is reviewed and landed, and CI answers for it. Output is a silent 1080p master plus
the shot list its beats sit on, for voice and music to be cut over.

```sh
pnpm -C _site/demo dev                     # the fixture app on :47146 — must be up first
cd _tools/e2e && node promo/record.mjs     # ~95s take → /work/.intentic/promo/
```

`DEMO_URL` and `PROMO_OUT` override the address and the output directory.

| File | What it is |
| --- | --- |
| `record.mjs` | capture settings, the pointer/pacing kit, the journey itself, and the ffmpeg delivery |
| `cursor.js` | injected before the app: the cursor a headless browser doesn't draw, its click ripple, the drag ghost |
| `dropped-repo.mjs` | the repository the take drags in, written to disk at record time (the drop is a real one) |

## It lives here because Playwright does

This is not a test and never runs in CI. It sits inside `@intentic-app/e2e` because that package already owns
this repo's browser automation and its `@playwright/test` install — a `_tools/promo` package would be the same
dependency, installed twice, to hold three files.

## Two things the take depends on

- **No reloads.** The fixture daemon is in-memory, so a reload rewinds the dropped repo and the landed delta.
  Everything after the first `goto` is an in-app click.
- **The turn waits for the pointer.** `/agent/attach` starts the scripted run and parks it on the plan card and
  the question card until this script answers, so the pauses are direction, not synchronisation.

Re-record after a UI change rather than patching the video; the selectors are the app's own roles and labels, so
a beat that moved will fail loudly instead of recording the wrong thing.
