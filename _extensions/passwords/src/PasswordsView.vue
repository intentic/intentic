<script setup lang="ts">
import { computed } from "vue";
import { PasswordsApp, type PasswordsSelection } from "./app/index.js";
import { passwordActivityQuery, passwordNeedsQuery, passwordsQuery } from "./extension.js";
import { host } from "./host.js";
import { createSandboxPort } from "./sandboxPort.js";

// The Passwords rail view in the hosted editor: the same app the desktop app mounts, over this sandbox's port, so a
// person sees what this sandbox may use, what it waits on, and a way to the computer where it is all managed. What is
// open lives in the route's query (`?filter=…&item=NAME&q=…`), so a view on one password can be linked.

const api = host();
const port = createSandboxPort({
    // Past the host's cache: the app reads again on focus, and a cached answer would hide a need just answered.
    passwords: () => api.sandbox.fetch({ ...passwordsQuery(), staleTime: 0 }),
    needs: () => api.sandbox.fetch({ ...passwordNeedsQuery(), staleTime: 0 }),
    activity: () => api.sandbox.fetch({ ...passwordActivityQuery(), staleTime: 0 }),
    // A navigation, not a fetch: the desktop app intercepts `intentic://`, and a browser hands it to the OS, which
    // opens the desktop app where one is installed.
    openLink: (link) => {
        globalThis.location.href = link;
    },
});

const selection = computed<PasswordsSelection>(() => {
    const query = api.route.query();
    return { filter: query[`filter`], item: query[`item`], query: query[`q`] };
});
const select = (next: PasswordsSelection): void =>
    api.route.setQuery({ filter: next.filter === `all` ? undefined : next.filter, item: next.item, q: next.query === `` ? undefined : next.query });
</script>

<template>
    <PasswordsApp :port="port" :selection="selection" @update:selection="select" />
</template>
