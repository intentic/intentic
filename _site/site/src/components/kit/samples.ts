// SAMPLE COPY for the /kit/ specimen page (pages/kit/[...kit].astro), which exists only under `astro dev`. None of it
// is a claim the site makes: it is here to fill every slot near its budget, so a component is judged at the size it
// will really carry. Real copy lives in @intentic/site-content.

import type { FlowNode, TipContent } from "./kit";

export const kitPage = {
    eyebrow: "Dev only",
    heading: "The design kit, in both skins.",
    lede: "Every token and component DESIGN.md names, on one page. All copy here is sample copy.",
    tip: {
        title: "Not shipped",
        body: "This page is built only by astro dev: its route returns no paths in production, and it is marked noindex.",
    } satisfies TipContent,
    skins: { dark: "Dark skin", light: "Light skin" },
    sample: "Sample copy",
};

export const sections = {
    tokens: { eyebrow: "Tokens", heading: "What every component reads.", lede: "Type, inks, metals, series, materials, grounds, rhythm and motion, from system.css and global.css." },
    budgets: { eyebrow: "Words", heading: "The copy budgets, as code.", lede: "Read from COPY_BUDGETS: a string over its ceiling fails the render." },
    glyphs: { eyebrow: "Glyph", heading: "The registry, in both renderings.", lede: "Gilt in a niche for a subject; a 1em line inside a control." },
    tips: { eyebrow: "Tip", heading: "Detail on demand.", lede: "Point at a term, an (i) or a whole tile; tab to one; tap one on a phone." },
    heads: { eyebrow: "SectionHead", heading: "Heads, start and centre.", lede: "Eyebrow, display-2 heading, one sentence, the (i), one action." },
    grounds: { eyebrow: "Band", heading: "The four grounds a band may choose.", lede: "The plate stays with a page's first screen and the closing band." },
    tiles: { eyebrow: "FeatureTile", heading: "Tiles in a grid of two, three or four.", lede: "Stone, a niche, a title, one line; the rest in the tile's Tip." },
    stats: { eyebrow: "Stat", heading: "Numbers that arrive.", lede: "Counted up once a third is in view; the final value is in the HTML." },
    flows: { eyebrow: "Flow", heading: "Work moving from step to step.", lede: "Wires draw, then a pulse lights each node in turn; off screen it rests." },
};

const sampleTip: TipContent = {
    title: "How it works",
    body: "An agent runs in its own sandbox with its own branch, and nothing lands on main until you have read the diff and approved it.",
    rows: [
        { label: "Sandbox", value: "Your machine" },
        { label: "Branch", value: "agent/fix-ci" },
    ],
    link: { label: "Read the docs", href: "/docs/" },
};

export const tipSamples = {
    sentence: "A sandbox is a machine your agents work on",
    term: { term: "sandbox", tip: { title: "A sandbox", body: "A machine you own, or one we host, where agents run with only the access you grant them." } satisfies TipContent },
    info: sampleTip,
    short: { title: "Plain", body: "A Tip with a title and a body, nothing else." } satisfies TipContent,
};

export const headSamples = {
    start: {
        eyebrow: "Automate",
        heading: "Start an agent from an event, not a prompt.",
        lede: "A push, an alert or a schedule wakes a fresh session that works on its own branch.",
        terms: { "fresh session": { title: "A fresh session", body: "A new agent with an empty context, its own transcript and its own checkout." } },
        tip: sampleTip,
        action: { label: "See automations", href: "/features/automate/" },
    },
    centre: {
        eyebrow: "Pricing",
        heading: "Free on your own machine, forever.",
        lede: "Pay only for the models you choose, at their own prices.",
        action: { label: "Download the app", href: "/download/", kind: "primary" as const },
    },
};

export const groundSamples = {
    wall: { eyebrow: "Wall", heading: "The default ground of a band.", lede: "An 84px gold hairline grid fading from the top." },
    lamp: { eyebrow: "Lamp", heading: "A band whose exhibit is the point.", lede: "A warm pool of light behind the exhibit, never two bands running." },
    plinth: { label: "A strip on the plinth" },
    plain: { eyebrow: "Plain", heading: "Text-dense bands stand on the canvas.", lede: "An FAQ, a ledger, a legal page." },
};

export const tileSamples = [
    {
        glyph: "agents",
        title: "Agent workspace",
        line: "Many agents on one board, each in its own sandbox.",
        tip: { title: "One board", body: "Every agent's card shows its model, branch, cost and diff, and opens on its transcript." },
        href: "/features/run/",
        action: "Open the board",
    },
    {
        glyph: "integrations",
        title: "Integrations",
        line: "Wire in outside systems with keys that stay yours.",
        tip: { title: "Your keys", body: "Credentials are stored in your sandbox, and an agent reaches a system only through the access you grant.", link: { label: "Read about access", href: "/docs/" } },
        href: "/features/connect/",
        action: "See integrations",
    },
    {
        glyph: "approvals",
        title: "Approvals",
        line: "Nothing lands until you have read the diff.",
        tip: { title: "The diff first", body: "An agent's change waits on its card with its tests until you approve, ask again or throw it away." },
        href: "/features/review/",
        action: "See approvals",
    },
    {
        glyph: "self-hosting",
        title: "Self-hosting",
        line: "Run the whole workspace on a machine you own.",
    },
] as const;

export const statSamples = {
    meter: { value: 5869, of: 6120, label: "commits by agents", tip: { title: "Counted at build", body: "Read from git when the page is built, never typed by hand.", rows: [{ label: "Since", value: "2026-07-12" }] } satisfies TipContent },
    prefix: { value: 20, prefix: "$", label: "a month, hosted" },
    suffix: { value: 99.9, suffix: "%", label: "uptime last quarter" },
    word: { word: "MIT", label: "the whole engine" },
    glyph: { value: 42, label: "extensions in the registry", glyph: "extensions" as const },
};

export const flowSamples = {
    caption: "An event wakes your check, and a pass starts a fresh session.",
    nodes: [
        { glyph: "branch", title: "A push", label: "GitHub · GitLab", tip: { title: "What wakes it", body: "A push, an alert, a payment, an email, a message or a schedule." } },
        { glyph: "command", title: "Your check", label: "exit 0", tip: { title: "Your command", body: "One line of yours reads the event first. Exit 0 wakes an agent; anything else is skipped and costs nothing." } },
        { glyph: "agents", title: "A fresh agent session", label: "its own branch", tip: { title: "The run", body: "It opens on your board with its own transcript, branch and checkout." } },
    ] satisfies FlowNode[],
};

export const longFlowSample = {
    caption: "Five steps from a request to a merged change.",
    nodes: [
        { glyph: "community", title: "You ask", label: "chat" },
        { glyph: "sandbox", title: "A sandbox starts", label: "your machine" },
        { glyph: "agents", title: "An agent works", label: "agent/fix-ci" },
        { glyph: "approvals", title: "You approve", label: "the diff" },
        { glyph: "branch", title: "It lands", label: "main" },
    ] satisfies FlowNode[],
};

export const compactFlowSample = {
    caption: "An event wakes your check, and a pass starts a fresh session.",
    nodes: [
        { glyph: "branch", title: "A push", label: "GitHub · GitLab" },
        { glyph: "command", title: "Your check", label: "exit 0" },
        { glyph: "agents", title: "A fresh agent session", label: "its own branch" },
    ] satisfies FlowNode[],
};
