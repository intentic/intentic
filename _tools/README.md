# Plumbing

Shared config and test harnesses, plus repo-wide maintainer scripts ([scripts/](scripts)) and non-package
seeds for external repos. Nothing here is product; a package lives here when every group needs it
(`tsconfig`, `constants`, `testing`) or when it exists for CI and release alone.

[nav/](nav) measures what this repository costs an *agent* to read — tokens spent locating and opening a
symbol — and gates a decomposition against removing a public export or moving a frozen contract file.
