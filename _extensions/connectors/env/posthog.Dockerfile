# posthog capability: the vendor's own agent-first CLI, which is where `posthog-cli api` comes from.
# The tool catalogue ships inside the binary, so this pin decides which tool names the skill's commands resolve to.
# The npm cache mount is the house rule for every fragment, not an optimisation for this one: an overlay is rebuilt
# in full whenever the sandbox image is updated. _tools/checks/build-cache-mounts.mjs enforces it.
# npm declines the package's postinstall, so the --version run is what downloads the platform binary into the image
# rather than into the agent's first command.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @posthog/cli@0.18.3 && posthog-cli --version
