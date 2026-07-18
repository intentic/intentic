---
name: environment
description: Extend this sandbox's own environment (system packages, language toolchains, SDKs — e.g. Rust, Android, JDK, Go, Python) by proposing custom Dockerfile steps the owner approves. Use when a task needs a tool that isn't installed and a runtime install wouldn't survive, or when the user asks to add capabilities to the sandbox itself.
---

# Sandbox environment (overlay Dockerfile)

You run inside a container built from `registry.gitlab.com/radarsu/intentic/sandbox:stable`. Anything you install at
runtime outside `/work` is lost when the container is recreated. To extend the environment permanently,
propose custom Dockerfile steps — the owner reviews and approves them, then a rebuild recreates the sandbox
(`/work` persists).

The final overlay (`.intentic/environment.approved.Dockerfile`) is COMPOSED BY THE DAEMON from three parts:
the pinned `FROM`, the enabled capabilities' fragments (daemon-owned — never copy or touch these), and the
owner-approved custom section. You propose ONLY custom-section content.

## How to propose

1. If `.intentic/environment.custom.Dockerfile` exists, start from its content — your proposal REPLACES the
   custom section (and only it), so carry the already-approved custom steps forward and add yours. An empty
   proposal clears the custom section.
2. Write your steps to `.intentic/environment.Dockerfile` (workspace-root-relative). `RUN` and `ENV` lines
   only — NO `FROM` (the daemon owns the base image; a proposal containing one is rejected), no
   `# intentic:runtime` lines (reserved for capability fragments), and no `USER`, `ENTRYPOINT`, `CMD`,
   `EXPOSE`, `WORKDIR`, or `COPY` (there is no build context). Never put secrets in it.
3. Install into system paths, not `/work` — the workspace volume mounts over `/work` and hides anything
   the image put there.
4. Steps must be self-contained: install (and clean up) your own build deps — capability fragments purge
   theirs, so don't rely on another layer's compilers.
5. apt hygiene: `RUN apt-get update && apt-get install -y --no-install-recommends <pkgs> && rm -rf /var/lib/apt/lists/*`.

Example (Rust toolchain):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
```

## After writing the file

Tell the owner to review and approve the change on the platform's **Sandbox page → Environment card**.
You cannot approve or apply it yourself; the rebuild runs outside this container (the owner pastes a
rebuild command locally, or it applies on the next `intentic apply` for server-managed sandboxes). Until
the rebuild, the new tools are not available — say so instead of retrying. A capability that extends the
image (VPN, Discord voice) composes its own fragment automatically — never propose an overlay for those,
just point the owner at the same rebuild.

For a SERVER-managed sandbox, also wire the approved overlay into the intent so `intentic apply` builds it:
in `intent/deploy.config.ts`, pass
`dockerfile: readFileSync("/work/.intentic/environment.approved.Dockerfile", "utf8")` to the
`i.want.workspace(…)` input — the content lands in the git-reviewed desired-state, which is the approval
gate on that path.
