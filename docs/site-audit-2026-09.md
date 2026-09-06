# Site audit: intentic.dev against openhands.dev, September 2026

Read the home page and the navigation as a stranger would, at 1440 and 390, and compared them with
openhands.dev, which sells the same category. Metadata measured over every page in the sitemap.

## Findings

1. **The bar was spent on builders.** Seven labels, four of them (Developers, API, Extensions, Earn) for
   somebody extending the product. Guides, Blog and Compare had no bar presence; `/blog/` had no inbound
   internal link at all on the live site.
2. **No pricing surface.** "Pricing" is the highest-intent click on a developer-tool site. A visitor who
   finds no link assumes the price is hidden, not that the product is free.
3. **Verbs, not jobs.** OpenHands names outcomes ("Fix CI failures automatically"). The Automate page
   explained a machine and never said what anyone automates with it.
4. **Two headings read as one word to machines.** `You delegate.Agents work.You approve.` and
   `Open-source and freeforever`: correct on screen, run together in the accessibility tree and snippets.
5. **Metadata over budget.** 43 descriptions over 160 characters (30 from one `/api/*` template), 11
   titles over 60, `/earn/` at 53.
6. **Dead copy slots.** `landing.ts` still carried fields for lines cut from the page months ago (a
   second subhead beat, a summary line, three chips, a `finalCta`). Slots nobody renders invite somebody to
   render them; the first pass of this work did exactly that and was reverted.

Not borrowed from OpenHands, on purpose: logo wall, testimonials, star counter, sales CTA, quiz. There is
nothing true to put in the first three, and the last two are stalls between the reader and the one button.

## Work order

| # | Change | Outcome |
| --- | --- | --- |
| 1 | Bar: Features, Docs, Resources (Guides, Blog, Compare, Changelog, Community), Developers (Build, Ship, Offer a paid service, Sandbox API, Extensions gallery, Earn), Pricing, About | Done. `nav.ts`; menus carry `prefixes: string[]`. Footer gains Pricing. |
| 2 | `/pricing/`: free beside the optional membership, figures from `pool.ts`, FAQPage node | Done. `pricing.ts`, `pricing.astro`. Decision recorded in landing-blueprint.md and messaging.md. |
| 3 | Six real automations on `/features/automate/`; the Automate line names two | Done. `product.ts`, `landing.ts`, `automate.ts` caption. |
| 4 | Whitespace between heading spans | Done. `h1.textContent` is `You delegate. Agents work. You approve.`; layout unchanged. |
| 5 | Descriptions to 160, titles to 60, `/earn/` description rewritten, home title uses its spare room | Done. `reference.ts` fits the book sentence to the budget and fails the build on a summary that does not fit. |
| 6 | Delete the dead slots in `landing.ts` | Done. No field for summary, chips or finalCta; the subhead is the one sentence the page shows. |
| 7 | `Content-Signal` in robots.txt | Done. |

## After

| Measure | Before | After |
| --- | --- | --- |
| Bar labels for builders | 4 of 7 | 1 of 6 |
| Inbound internal links to `/blog/` | 0 | every page |
| Descriptions over 160 | 43 | 0 |
| Titles over 60 | 11 | 0 |
| Headings run together for machines | 2 | 0 |
