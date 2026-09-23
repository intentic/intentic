// Code samples that contain a literal `<script>` tag, kept out of `.astro` files on purpose. Vite's dependency
// scanner treats an `.astro` file as an HTML type and regex-lifts every `<script>…</script>` out of it — frontmatter
// string literals included — then parses the result as TypeScript and resolves its imports as real ones. A sample
// written inline fails `astro dev` at the scan, before Astro's own parser ever sees the file. In a `.ts` module the
// same text is just a string.

/** The Vue view from /developers/build, step 4. */
export const incidentsView = `<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { host } from "./host";

// One activation per repo. The host binds \`repo\` (and any extra props) for you.
const props = defineProps<{ repo: string }>();

const { data } = useQuery({
    // Always prefix with api.sandbox.key(...) so the cache can't bleed across a sandbox switch.
    queryKey: host.sandbox.key(\`incidents\`, props.repo),
    // A daemon route by name, allowed by the manifest's "GET /logs"; the answer arrives parsed by the route's schema.
    queryFn: () => host.sandbox.rpc.logs.list(),
    enabled: () => host.sandbox.reachable(),
});
</script>

<template>
    <ul>
        <li v-for="file in data?.files ?? []" :key="file.name">{{ file.name }}</li>
    </ul>
</template>`;
