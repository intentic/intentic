<script setup lang="ts">
import { InfoDialog } from "@intentic/ui";

/* The (i) beside "Repository checks". */

const EXAMPLE = `{
  "checks": [
    { "when": "edit", "run": "pnpm lint {file}" },
    { "when": "push", "run": "pnpm verify:push" },
    { "when": "turn", "run": "pnpm verify:turn", "paths": ["src/**"] }
  ]
}`;
</script>

<template>
    <InfoDialog title="Repository checks">
        <p class="text-sm text-muted">
            A repository can say what should be run on its own code. It goes in the repository, at
            <span class="font-mono text-content">.intentic/checks.json</span>, and travels with it: a teammate who clones it gets the same checks, and
            renaming the script and the check that calls it is one commit.
        </p>
        <pre class="mt-3 overflow-x-auto rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
        <p class="mt-2 text-2xs text-muted">
            <span class="font-mono">when</span> is <span class="font-mono">edit</span> (on each file as it is written, where
            <span class="font-mono">{file}</span> becomes its path), <span class="font-mono">turn</span> (before the assistant finishes) or
            <span class="font-mono">push</span> (before anything leaves the machine). An <span class="font-mono">edit</span> check runs once per
            file written, so it has to be one that takes a file. The command runs
            <span class="font-medium text-content">in that repository</span>, so it reads exactly as it would in a terminal there — no
            <span class="font-mono">cd</span> in front of it. Paths are written relative to the repository.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Why you have to switch it on</h3>
        <p class="mt-1.5 text-2xs text-muted">
            A file in a repository is a command somebody else may have written, and it would otherwise run on your machine without being read. So
            nothing declared runs until you switch it on here, and if the declaration changes afterwards it stops until you look again. Git has kept
            the same rule since the beginning: hooks are never cloned.
        </p>

        <h3 class="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">What stays yours</h3>
        <p class="mt-1.5 text-2xs text-muted">
            A repository may say what to run. What happens when it fails is yours and stays in your settings: whether work lands, whether a push goes,
            what an agent may reach for. A repository cannot lower a bar you set.
        </p>
    </InfoDialog>
</template>
