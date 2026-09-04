# Plumbing

Shared config and test harnesses, plus repo-wide maintainer scripts and non-package seeds for external repos.
Nothing here is product; a package lives here when every group needs it (`tsconfig`, `constants`, `testing`)
or when it exists for CI and release alone.

Two directories carry the commands rather than the code. [checks/](checks) is every gate that reads the
checkout and nothing else, listed once in its manifest and run everywhere that list is read.
[scripts/](scripts) is everything else this repository runs around the code — verifying, building, publishing,
and standing machines up — grouped by who it serves, one family per directory, with the shared decisions in
`scripts/lib`. Each has a README naming every file in it.

[nav/](nav) measures what this repository costs an *agent* to read — tokens spent locating and opening a
symbol — and gates a decomposition against removing a public export or moving a frozen contract file.
