# Screenshot renditions

What a chat's screenshots cost to show, measured on 2026-09-22, and the encoder settings chosen from it for
`/workspace/thumb` (`_sandbox/sandbox/src/workspace/files/workspace-thumbnail.ts`).

## Why

Screenshots in the chat were slow to appear. The editor's own reports put `/workspace/raw`, which then served
every picture in the chat, at 1.8 to 6.3 seconds per request on 2026-09-21 and 22. The daemon's own span for one
of them was 3.8 seconds at a load average of 5. The files were sent as the PNGs the browser tools wrote.

## The pictures

2,557 PNG screenshots in `.intentic/records/artifacts/browser/`, 1.0 GB in total:

| | median | p90 | p99 | max |
|---|---|---|---|---|
| size | 187 KB | 1,008 KB | 1,536 KB | 3,814 KB |
| width | 1,279 px | 1,500 px | | 3,800 px |
| height | 852 px | 1,100 px | | 12,527 px |

332 of them (13%) are more than twice as tall as they are wide: full-page captures.

## Encoders

29 screenshots spread across the size range plus the four tallest, 17.9 MB as PNG, each encoded at its own size
(capped at 2,560 px wide), with sharp 0.35.4 on the sandbox's 16 cores:

| encoder | total | smaller than PNG | mean encode | slowest |
|---|---|---|---|---|
| WebP q80, effort 2 | 2,035 KB | 8.8× | 44 ms | 280 ms |
| WebP q80, effort 2, smart subsampling | 2,145 KB | 8.3× | 177 ms | 1,375 ms |
| AVIF q50, effort 0 | 1,574 KB | 11.3× | 77 ms | 512 ms |
| AVIF q55, effort 1 | 1,406 KB | 12.7× | 172 ms | 1,125 ms |
| AVIF q60, effort 1 | 1,617 KB | 11.0× | 176 ms | 1,147 ms |
| AVIF q55, effort 2 | 1,348 KB | 13.2× | 307 ms | 1,753 ms |
| AVIF q60, effort 0, 4:2:0 | 2,065 KB | 8.6× | 60 ms | 362 ms |

Cropped at 1:1 on two text-heavy dark screenshots, AVIF q50 at effort 0 showed ringing around text and borders.
AVIF q55 at effort 1 and WebP q80 were indistinguishable from the PNG.

## Tiles

The home's 256 px tile draws the whole picture inside its box, so a full-page capture came out as a sliver
(1425 × 12527 became 29 × 256) and a strip tile blew it up. A 480 × 300 tile cut from the top of the page:

| encoder | mean size | mean encode |
|---|---|---|
| WebP q75, effort 2 | 6.4 KB | 10 ms |
| AVIF q50, effort 1 | 5.3 KB | 25 ms |

## What was chosen

- **view** (the viewer and tool cards): the picture at its own size, AVIF q55 effort 1 for a reader whose `Accept`
  names AVIF, else WebP q80 effort 2. About 13× smaller than the PNG; the encode is paid once per version and
  cached.
- **strip** (a turn's strip, the viewer's filmstrip): 480 × 300 from the top of the page, WebP. AVIF saves about
  1 KB a tile at 2.5× the encode, and a strip asks for four at once.
- **tile** (the home): unchanged, 256 px inside, WebP.
- At most two renders run at once. Each holds one of libuv's four threads for its whole decode and encode, and
  those threads also serve the daemon's file reads.
- The original is read only for actual size and download.
