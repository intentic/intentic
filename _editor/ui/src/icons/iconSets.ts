// The app's icon vocabulary and how each name resolves. Keys are the stable semantic names (the old PrimeIcons
// suffixes, verbatim); values are Iconify ids from Remix.
//
// ONE SET, and the id column is the only place a glyph is chosen. There used to be five complete sets here —
// Phosphor, Solar, Remix, HugeIcons and PrimeIcons — behind a Settings control that let them be compared live in
// the running app. That control had done its job: Remix was picked, and what was left was 530 lines of mappings
// nobody read and a bundled SVG payload five times the size of the icons the app can actually draw. Comparing a
// candidate set again is a branch, not a shipped feature.
//
// Every id referenced here is bundled offline: scripts/generateIconData.ts trims the used icons out of the full
// @iconify-json/ri set into src/icons/iconData.generated.ts, which installUi() registers via addCollection. So no
// runtime Iconify API fetch. Regenerate (pnpm --filter @intentic/ui generate:icons) whenever these change.

export type IconName =
    | "align-left"
    | "angle-right"
    | "arrow-circle-up"
    | "arrow-down-left"
    | "arrow-left"
    | "arrow-right"
    | "arrow-up-right"
    | "arrows-h"
    | "backward"
    | "bars"
    | "bolt"
    | "book"
    | "box"
    | "check"
    | "check-circle"
    | "check-square"
    | "chevron-down"
    | "chevron-right"
    | "chevron-up"
    | "circle"
    | "circle-fill"
    | "clock"
    | "clone"
    | "cloud"
    | "cloud-upload"
    | "code"
    | "cog"
    | "collapse-all"
    | "comments"
    | "compress"
    | "copy"
    | "credit-card"
    | "database"
    | "desktop"
    | "download"
    | "envelope"
    | "eraser"
    | "exclamation-circle"
    | "exclamation-triangle"
    | "expand"
    | "external-link"
    | "eye"
    | "eye-slash"
    | "file"
    | "file-edit"
    | "file-pdf"
    | "filter"
    | "folder"
    | "folder-open"
    | "forward"
    | "github"
    | "gitlab"
    | "globe"
    | "google"
    | "history"
    | "image"
    | "info-circle"
    | "key"
    | "link"
    | "list-check"
    | "lock"
    | "microphone"
    | "moon"
    | "palette"
    | "paperclip"
    | "pause"
    | "pencil"
    | "picture-in-picture"
    | "play"
    | "plus"
    | "plus-circle"
    | "question-circle"
    | "refresh"
    | "repeat"
    | "save"
    | "search"
    | "send"
    | "server"
    | "shield"
    | "sign-in"
    | "sign-out"
    | "sitemap"
    | "slack"
    | "sliders-h"
    | "sparkles"
    | "spinner"
    | "square"
    | "star"
    | "star-fill"
    | "stop"
    | "sun"
    | "sync"
    | "terminal"
    | "th-large"
    | "times"
    | "trash"
    | "undo"
    | "unlock"
    | "upload"
    | "user"
    | "users"
    | "volume-off"
    | "volume-up"
    | "wave-pulse"
    | "wifi"
    | "window-maximize"
    | "window-minimize"
    | "wrench";

export const ICONS: Record<IconName, string> = {
    "align-left": "ri:align-left",
    "angle-right": "ri:arrow-right-s-line",
    "arrow-circle-up": "ri:arrow-up-circle-line",
    "arrow-down-left": "ri:arrow-left-down-line",
    "arrow-left": "ri:arrow-left-line",
    "arrow-right": "ri:arrow-right-line",
    "arrow-up-right": "ri:arrow-right-up-line",
    "arrows-h": "ri:arrow-left-right-line",
    bars: "ri:menu-line",
    bolt: "ri:flashlight-line",
    book: "ri:book-open-line",
    box: "ri:box-3-line",
    check: "ri:check-line",
    "check-circle": "ri:checkbox-circle-line",
    "check-square": "ri:checkbox-line",
    "chevron-down": "ri:arrow-down-s-line",
    "chevron-right": "ri:arrow-right-s-line",
    "chevron-up": "ri:arrow-up-s-line",
    circle: "ri:circle-line",
    "circle-fill": "ri:circle-fill",
    clock: "ri:time-line",
    clone: "ri:file-copy-line",
    cloud: "ri:cloud-line",
    "cloud-upload": "ri:upload-cloud-line",
    code: "ri:code-line",
    cog: "ri:settings-3-line",
    // Was a Phosphor borrow (`ph:arrows-in-line-vertical`) while five sets shipped — Remix's own converging-
    // arrows glyph is the same idea and keeps the whole table on one prefix.
    "collapse-all": "ri:collapse-vertical-line",
    comments: "ri:chat-2-line",
    copy: "ri:file-copy-line",
    "credit-card": "ri:bank-card-line",
    database: "ri:database-2-line",
    desktop: "ri:computer-line",
    download: "ri:download-line",
    envelope: "ri:mail-line",
    eraser: "ri:eraser-line",
    "exclamation-circle": "ri:error-warning-line",
    "exclamation-triangle": "ri:alert-line",
    "external-link": "ri:external-link-line",
    eye: "ri:eye-line",
    "eye-slash": "ri:eye-off-line",
    file: "ri:file-line",
    "file-edit": "ri:file-edit-line",
    "file-pdf": "ri:file-pdf-line",
    filter: "ri:filter-3-line",
    folder: "ri:folder-line",
    "folder-open": "ri:folder-open-line",
    forward: "ri:forward-end-line",
    github: "ri:github-line",
    gitlab: "ri:gitlab-line",
    globe: "ri:global-line",
    google: "ri:google-line",
    history: "ri:history-line",
    image: "ri:image-line",
    "info-circle": "ri:information-line",
    key: "ri:key-2-line",
    link: "ri:link",
    "list-check": "ri:list-check",
    lock: "ri:lock-2-line",
    microphone: "ri:mic-line",
    moon: "ri:moon-line",
    palette: "ri:palette-line",
    paperclip: "ri:attachment-line",
    pencil: "ri:pencil-line",
    play: "ri:play-line",
    backward: "ri:rewind-mini-line",
    compress: "ri:fullscreen-exit-line",
    expand: "ri:fullscreen-line",
    pause: "ri:pause-line",
    "picture-in-picture": "ri:picture-in-picture-line",
    repeat: "ri:repeat-2-line",
    "volume-off": "ri:volume-mute-line",
    "volume-up": "ri:volume-up-line",
    plus: "ri:add-line",
    "plus-circle": "ri:add-circle-line",
    "question-circle": "ri:question-line",
    refresh: "ri:refresh-line",
    save: "ri:save-line",
    search: "ri:search-line",
    send: "ri:send-plane-line",
    server: "ri:server-line",
    shield: "ri:shield-check-line",
    "sign-in": "ri:login-box-line",
    "sign-out": "ri:logout-box-line",
    sitemap: "ri:organization-chart",
    // One of the few brands the icon CDN cannot serve at all — it holds no Slack mark, so the card that wants
    // one has to find it here or fall to a generic speech bubble, which is what it did.
    slack: "ri:slack-line",
    "sliders-h": "ri:equalizer-line",
    sparkles: "ri:sparkling-line",
    spinner: "ri:loader-4-line",
    square: "ri:checkbox-blank-line",
    star: "ri:star-line",
    "star-fill": "ri:star-fill",
    stop: "ri:stop-circle-line",
    sun: "ri:sun-line",
    sync: "ri:restart-line",
    terminal: "ri:terminal-box-line",
    "th-large": "ri:layout-grid-line",
    times: "ri:close-line",
    trash: "ri:delete-bin-line",
    undo: "ri:arrow-go-back-line",
    unlock: "ri:lock-unlock-line",
    upload: "ri:upload-line",
    user: "ri:user-line",
    users: "ri:group-line",
    "wave-pulse": "ri:pulse-line",
    wifi: "ri:wifi-line",
    "window-maximize": "ri:fullscreen-line",
    "window-minimize": "ri:fullscreen-exit-line",
    wrench: "ri:wrench-line",
};

/* Is this string a name the app can actually draw?
 *
 * Every icon name that arrives from OUTSIDE the app is an open string — `Activation.icon`, a manifest's `icon`,
 * a capability card's, a document offer's — because a third-party extension is written against a build that
 * has not shipped yet and must install anyway. <Icon> takes the closed `IconName`, so the cast has to be
 * checked somewhere, and an UNchecked one is not a loud failure: `ICONS[name]` is undefined, Iconify renders
 * nothing, and the tile comes up blank (which shipped once, as `book`). Asking here lets a renderer fall to its
 * next tier — a glyph, then initials — instead of to a hole. */
export const isIconName = (name: string): name is IconName => name in ICONS;
