/* THE POP-OUT WINDOW'S BOOT, and it is one import on purpose.
 *
 * Everything a floating panel shows is rendered by the window that opened it — the demo's own tab, holding the
 * fixture — so this document runs none of the app and none of this package: no transports to install, no
 * credentials to seed, nothing to serve. What it does run is the app's keeper, the script that answers its
 * opener's "is a live page driving me?" and is the only way a panel ever reaches a window
 * (_apps/web/src/composables/usePopout.ts).
 *
 * Reached through the app's package export rather than a relative path across packages, the same way this
 * package reaches the app's entry from `main.ts`. */
import "@intentic-app/web/popout-keeper";
