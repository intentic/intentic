# @intentic/ext-rtk

Ships the [rtk](https://github.com/rtk-ai/rtk) binary (Apache-2.0) into the sandbox image overlay so it can be
benchmarked head-to-head against the native output filter.

## How it plugs in

- **This extension** only contributes an environment fragment ([env/rtk.Dockerfile](env/rtk.Dockerfile)) that
  installs `rtk` onto the image PATH. No code, no UI.
- **The switch** is the per-sandbox `filterBackend` setting (Sandbox → Agent settings): `"native"` uses
  `agent-output-filter`; `"rtk"` makes the agent's PreToolUse hook rewrite every Bash command to `rtk <cmd>` and
  turns the native filter off, so rtk owns the compression. Both paths still run through `tmux-run`, so the
  terminal panel and pane logs are unchanged.

## Enabling it

1. Install this extension and approve the composed environment overlay, then rebuild the sandbox image
   (Environment card) — the same out-of-band rebuild any image fragment needs.
2. Set `filterBackend` to `rtk`.
3. Compare the `usage`/activity ledger across sessions against the native backend.

Until the rebuild lands, `rtk` is not on PATH and `filterBackend: "rtk"` makes commands fail with
`rtk: command not found` — so flip the setting only after the rebuild. `jfrog/boost` is intentionally not
bundled (proprietary).
