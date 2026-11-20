import type { BrowserMediaClientMessage } from "@intentic/sandbox-contract/browser-wire";
import type { Surface } from "./decodeSeams";
import type { MediaStats } from "../frameBook";

// WHAT THE PAGE AND ITS DECODE WORKER SAY TO EACH OTHER (decodeCore.ts). The worker holds the media socket itself, so a
// picture never waits on the page's main thread (a Vue render, a collection): it decodes, draws, acks and keeps the
// sound flowing on its own, and hands the page only what the page acts on (the socket's JSON messages, the picture's
// size, its edge colour, stats while they are shown). Each socket the page dials is numbered, so the open and close of
// one it has since replaced are told apart.

export type ToWorker =
    // `transport`: the edge declared WebTransport, so the socket may ride a stream of its session (mediaCarrier.ts).
    | { readonly type: `dial`; readonly socket: number; readonly url: string; readonly transport: boolean }
    | { readonly type: `hangup`; readonly socket: number }
    | { readonly type: `send`; readonly message: BrowserMediaClientMessage }
    // Where to draw: the OffscreenCanvas the page's canvas element handed over; undefined lets go of the one it had (its
    // element left the page).
    | { readonly type: `canvas`; readonly canvas: Surface | undefined }
    // The audio thread's end of a channel for decoded sound; undefined stops decoding sound.
    | { readonly type: `audio`; readonly port: MessagePort | undefined }
    // The tab the picture shows is `key` (window and page): `switching` when the person just picked it, which shows its
    // last picture at once and holds it until the live picture of it arrives.
    | { readonly type: `page`; readonly key: string; readonly switching: boolean }
    // The window says `key` is in front now: frames captured from here on show it.
    | { readonly type: `fronted`; readonly key: string }
    | { readonly type: `stats`; readonly on: boolean }
    // Read the picture's edge colour now (the stage changed size).
    | { readonly type: `edge` }
    // Another window: its picture, decoders and stream go; the tabs' last pictures stay.
    | { readonly type: `reset` }
    // The page's peer connection to castd (mediaRtc.ts) carries the viewer's messages now, or no longer: while it does,
    // what this worker would send on the socket (acks, pings) is handed to the page for the peer's `input` channel.
    | { readonly type: `peer`; readonly open: boolean }
    // A message castd sent on the peer, whole: read exactly as one from the socket.
    | { readonly type: `peerData`; readonly data: string | ArrayBuffer };

export type FromWorker =
    | { readonly type: `open`; readonly socket: number }
    | { readonly type: `close`; readonly socket: number; readonly code: number; readonly reason: string }
    | { readonly type: `text`; readonly socket: number; readonly data: string }
    // Something arrived on the socket: what keeps the page's silence clock from closing a socket that only sends video.
    | { readonly type: `heard`; readonly socket: number }
    // The canvas is now this many pixels: on the first frame of every new size.
    | { readonly type: `painted`; readonly width: number; readonly height: number }
    // The first frame since a `hello` (or since the canvas came) is on the canvas.
    | { readonly type: `picture` }
    | { readonly type: `edge`; readonly colour: string | undefined }
    | { readonly type: `stats`; readonly stats: MediaStats }
    // This browser cannot decode what castd sends, in the decoder's words.
    | { readonly type: `failed`; readonly message: string }
    // For castd over the peer's `input` channel, which the page holds (`peer` says when).
    | { readonly type: `peerSend`; readonly message: BrowserMediaClientMessage };
