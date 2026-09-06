# @intentic/share-view

The read-only page a conversation shared to the public is published as.

A shared conversation is handed to strangers, so this is deliberately the smallest app in the repository: no
router, no daemon client, no store, no sign-in, no configuration. The whole conversation is already in the
document when the page loads, and the app is one component over it. That is what makes the page safe to serve
from anywhere — there is nothing for a visitor to authenticate to, and nothing for the page to fetch.

It shares the design system (`@intentic/ui`) and the transcript components with the editor, so a shared
transcript reads the way it read in the app rather than being a second renderer that drifts.

## Key files

- [`src/main.ts`](src/main.ts) — the boot, and by what it does not do, most of the argument above.
- [`src/payload.ts`](src/payload.ts) — the conversation as it arrives: one JSON block baked into the page.
- [`src/ShareApp.vue`](src/ShareApp.vue) — the page: the transcript and nothing around it.
- [`src/shareSurface.ts`](src/shareSurface.ts) — what a shared tool call is allowed to show, which is less than
  the app shows its owner.
