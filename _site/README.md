# The public site

The public website intentic.dev: its pages, the words and page trees they render, the build-time integrations, and the interactive demo that runs the real editor on fixture data.

```mermaid
flowchart LR
    content["site-content<br/>words, page trees"] --> site(["site<br/>astro build"])
    integrations["astro-integrations<br/>llms.txt, search, dates"] --> site
    demo["demo<br/>editor on fixtures"] -->|"built into public/demo/"| site
    registry["intentic/registry<br/>on GitHub"] -->|"at build"| site
    site --> worker["worker.ts<br/>Cloudflare Worker"]
    live["content/live.json<br/>on GitHub"] -->|"per request"| worker
    worker --> visitor["Visitor on<br/>intentic.dev"]
```

| Package | Role |
| --- | --- |
| [site](site) | The Astro site and the Worker that serves intentic.dev. |
| [site-content](site-content) | Typed copy, documentation trees and page metadata the site renders. |
| [astro-integrations](astro-integrations) | Build hooks: llms.txt, Markdown mirrors, docs search, sitemap dates, build-time figures. |
| [demo](demo) | The real editor against an in-browser fixture, served at `/demo/`. |
