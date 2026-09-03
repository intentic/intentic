# mysql capability: the mysql client so the agent can query the connected database.
# The apt cache mounts are the house rule for every fragment, not an optimisation for this one: an overlay is
# rebuilt in full whenever the sandbox image is updated, so without them each update re-downloads every
# capability's packages. _tools/checks/build-cache-mounts.mjs enforces it.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends default-mysql-client
