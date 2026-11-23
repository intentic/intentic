import { settleAsGuest } from "./embed";

// THE DEMO'S ENTRY, kept to two steps so their order holds in a production build.
//
// 1. embed.ts, which imports nothing: embedded as the landing page's hero, the demo swaps localStorage, sessionStorage
//    and IndexedDB for stores of its own, so that has to happen before any module that reads them is loaded.
// 2. Everything else (boot.ts: the fakes, the seeded session, then the app), imported dynamically after it.
//
// Why: in a bundle, every chunk a module imports statically runs before that module's own body. boot.ts's imports
// reach the editor's i18n and preference modules, which read storage as they load, and the account storage module
// caches which account's drawer is open on its first read. While those imports sat here, a visitor who had opened /demo/
// before had that read come from their real localStorage ("demo-user"), so the sealed store's seeded daemon session was
// never moved into the drawer, the app found no session, waited on a sign-in nobody saw, and the hero showed
// "acme-shop is busy" (2026-11-23). Vite's dev server loads modules one by one, so it never showed there.
settleAsGuest();

await import("./boot");
