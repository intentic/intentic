# What the sandbox's Start button runs for this repository (_sandbox/sandbox/src/panels/run-plan.ts): the editor's demo
# build, the real editor on fixture data, so it needs no platform API, no sandbox daemon, no database and no sign-in.
# Given the PORT Start assigns, the demo's dev script runs Vite in the foreground on it and accepts the preview URL's
# host (_site/demo/scripts/dev.mjs, vite.config.ts); its address redirects to /demo/.
# The full local stack (Postgres, API, editor, site) is still `pnpm dev`, run by hand where Docker is available.
web: pnpm -C _site/demo dev
