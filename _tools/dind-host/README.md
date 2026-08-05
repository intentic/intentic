# @intentic/dind-host

A Docker-in-Docker image that stands in for a user's machine when a test needs a real Docker to talk to.

## Responsibilities

- Provide a container that runs a Docker daemon, so a sandbox can be created inside a test the way it would be on
  someone's laptop.

## Key files

- [Dockerfile](Dockerfile) — the image.
- [entrypoint.sh](entrypoint.sh) — bringing the inner daemon up before handing over.

## How it fits

Test infrastructure, not product. It exists so the paths that create a sandbox can be exercised end to end
without a real machine — the same reason `_tools/desktop-smoke` exists for installers.

## Conventions & gotchas

- Privileged by necessity. This is a test host, and nothing about it is a model for how a sandbox itself runs.
