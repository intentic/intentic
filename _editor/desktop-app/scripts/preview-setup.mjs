import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { join, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repoRoot = join(appRoot, "../..");
const previewDir = join(appRoot, ".preview-setup");

await mkdir(previewDir, { recursive: true });

await writeFile(
    join(previewDir, "index.html"),
    `<!doctype html>
<html lang="en" data-mode="dark" data-skin="sanctum">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Setup preview</title>
  <script type="module" src="/main.ts"></script>
</head>
<body>
  <div id="app"></div>
</body>
</html>`,
);

await writeFile(
    join(previewDir, "main.ts"),
    `
import { installUi, AppBrand, ui } from "@intentic/ui";
import { startI18n } from "@intentic/ui/i18n";
import { createApp, h, ref } from "vue";
import SetupProgress from "${appRoot}/src/components/SetupProgress.vue";
import { registerDesktopCatalog } from "${appRoot}/src/i18n/index.ts";
import "${appRoot}/src/styles.css";

await registerDesktopCatalog();
await startI18n();

const view = {
  percent: 48,
  position: "Step 5 of 10",
  remaining: "about 3 minutes",
  steps: [
    { phase: "fetching-ic", label: "Fetch the installer", state: "done", detail: undefined, share: 0.08 },
    { phase: "checking-docker", label: "Check Docker", state: "done", detail: undefined, share: 0.05 },
    { phase: "installing-docker", label: "Install Docker", state: "done", detail: undefined, share: 0.35 },
    { phase: "preflight", label: "Check this device", state: "done", detail: undefined, share: 0.05 },
    { phase: "claiming-code", label: "Redeem setup code", state: "done", detail: undefined, share: 0.03 },
    { phase: "pulling-image", label: "Download the sandbox image", state: "running", detail: "pulling sandbox image ghcr.io/intentic/sandbox:stable (first run can take a minute)...", share: 0.18 },
    { phase: "starting-sandbox", label: "Start the sandbox", state: "waiting", detail: undefined, share: 0.04 },
    { phase: "waiting-health", label: "Wait for it to come up", state: "waiting", detail: undefined, share: 0.06 },
    { phase: "verifying", label: "Check it answers", state: "waiting", detail: undefined, share: 0.03 },
    { phase: "connecting-machine", label: "Connect this device", state: "waiting", detail: undefined, share: 0.13 },
  ],
};

const app = createApp({
  setup() {
    const open = ref(false);
    return () =>
      h("div", { class: "entry launcher h-dvh overflow-auto bg-canvas text-content" }, [
        h("div", { class: "flex w-full flex-col gap-5 p-6", style: "width: 520px; margin: 0 auto;" }, [
          h("header", { class: "flex items-center gap-3 select-none" }, [
            h(AppBrand, { shape: "mark", class: "shrink-0 text-2xl" }),
            h("h1", { class: "min-w-0 flex-1 text-2xl leading-tight font-semibold" }, [
              "Setting up ",
              h("span", {}, "workspace"),
              h("span", { class: "text-primary-fill" }, "."),
            ]),
            h("button", { type: "button", class: ui.iconButton("-my-0.5 h-7 w-7"), "aria-label": "Back to your workspace" }, "×"),
          ]),
          h(
            "p",
            { class: "-mt-2 max-w-read-sm text-sm leading-relaxed text-muted" },
            "We're getting this computer ready and starting your sandbox. It usually takes a few minutes, and your workspace opens by itself when it's done.",
          ),
          h(SetupProgress, {
            events: [],
            view,
            running: true,
            open,
            "onUpdate:open": (v) => {
              open.value = v;
            },
          }),
          h("footer", { class: "flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-subtle" }, [
            h("span", { class: "min-w-0 flex-1" }, "Closing this window doesn't stop it — your workspace shows the same progress."),
            h("button", { type: "button", class: ui.textAction("shrink-0") }, "Stop"),
            h("button", { type: "button", class: ui.textAction("shrink-0") }, "Show the log"),
          ]),
        ]),
      ]);
  },
});
installUi(app);
app.mount("#app");
`,
);

const server = await createServer({
    root: previewDir,
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            "@intentic/ui/device-agent": join(repoRoot, "_editor/ui/src/components/sandbox/deviceAgent.ts"),
            "@intentic/ui/i18n": join(repoRoot, "_editor/ui/src/i18n/index.ts"),
            "@intentic/ui": join(repoRoot, "_editor/ui/src/index.ts"),
        },
        dedupe: ["vue"],
    },
    optimizeDeps: {
        include: ["vue"],
    },
    server: { host: "127.0.0.1", port: 47149, strictPort: true, fs: { allow: [repoRoot] } },
});

await server.listen();
console.log("preview at http://127.0.0.1:47149/");

process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
