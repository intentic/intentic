// The example card's recorded run: SAMPLE CONTENT, labelled "Example" wherever it is drawn (ExampleAgentCard). Code is
// code in every language, so the diff is the same for every reader; the words around it are in the catalog.

export interface ExampleFile {
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
}

export const EXAMPLE_FILES: readonly ExampleFile[] = [
    { path: `src/theme.ts`, additions: 18, deletions: 0 },
    { path: `src/components/Header.vue`, additions: 7, deletions: 1 },
    { path: `src/styles.css`, additions: 15, deletions: 1 },
];

export const EXAMPLE_DIFF = `--- a/src/components/Header.vue
+++ b/src/components/Header.vue
@@ -1,9 +1,15 @@
 <script setup lang="ts">
+import { useTheme } from "../theme";
+
+const { dark, toggle } = useTheme();
 </script>

 <template>
     <header class="header">
         <h1>My app</h1>
-        <nav><a href="/about">About</a></nav>
+        <nav>
+            <a href="/about">About</a>
+            <button type="button" :aria-pressed="dark" @click="toggle">Dark mode</button>
+        </nav>
     </header>
 </template>`;
