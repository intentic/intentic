/* THE STARTER SITE'S NAMES, declared where both sides of the wire read them.
 *
 * A fresh sandbox opens with one real, running thing in it: a one-page site, copied out of the image and
 * started by the daemon's first boot (sandbox src/scaffold/starter-site.ts). The browser's job is the other
 * half of that promise, to have it on screen when the user arrives (web shell/ShellDesktop.vue), and to do
 * that it has to name the same repo and the same app the daemon seeded.
 *
 * Two constants rather than one because they are two different kinds of name: `site` is the repo directory a
 * person would have picked, and `landing` is the template's own app name, which the apps extension, the
 * preview hostname (preview-site--landing-<id>.<zone>) and the folder under `_apps/` all inherit. Renaming
 * either is a product decision, not a rename: the seeded workspaces already out there keep the old names. */
export const STARTER_REPO = "site";
export const STARTER_APP = "landing";
