# The messaging gateway runtimes — deployed trees from the `trees` build context, so this pack is BAKE-ONLY
# (profiles can include it; an overlay rebuild cannot, and the daemon surfaces "not in this image" for a
# messaging connector on a core image instead — capabilities/extension-inventory/extension-readiness.ts). Their MANIFESTS are baked
# in every image by the core Dockerfile so the capability cards exist either way; these COPYs put the runnable
# gateways behind them.
# The discord gateway's voice stack needs no rebuild after this COPY: its Opus decoder is mediaplex, a napi-rs
# binding whose per-platform build arrives as a prebuilt optional dependency with no install script, so the
# deployed tree is already correct for this image. It used to rebuild @discordjs/opus here, source-compiled
# against whatever host ran pnpm deploy — that binding is gone, and with it the tar 6.2.1 its node-pre-gyp
# installer dragged in.

# The gateways' third-party packages, one static layer root for all of them (prepare-image-trees.sh moves them out of
# each deployed tree and fixes every timestamp): the same bytes on every release whose lockfile moved none of them, so
# an update keeps the layer. compose-image-dockerfile.mjs splices this COPY above the per-commit trees with the
# pre-trees packs; the trees below merge over it. What they share with the daemon's tree is not here at all: it is a
# link into /opt/sandbox's copy (the dedupe in prepare-image-trees.sh).
COPY --link --from=trees layers/messaging-deps/ /

COPY --from=trees extensions/discord /opt/extensions/discord
COPY --from=trees extensions/imap /opt/extensions/imap
# The slack gateway is pure JS (Socket Mode over undici) — no native build step to redo after the COPY.
COPY --from=trees extensions/slack /opt/extensions/slack
# The telegram gateway is pure JS AND dependency-free (the Bot API is fetch + JSON), so its tree is its own dist.
COPY --from=trees extensions/telegram /opt/extensions/telegram
# The whatsapp gateway is JS + WASM (baileys' crypto bridge ships compiled wasm) — no native build step either.
COPY --from=trees extensions/whatsapp /opt/extensions/whatsapp
# google-workspace ships more than a gateway: the same tree carries `gw`, the agent's Google CLI (contributes.bin
# → bin/gw, a launcher over the built dist/). Dependency-free like telegram — Google's APIs are fetch and JSON —
# so its tree is its own dist plus the two workspace packages it types against.
COPY --from=trees extensions/google-workspace /opt/extensions/google-workspace
# microsoft-365 is the same shape: `m365` (bin/m365) and the inbox watcher over its dist, fetch and JSON only.
COPY --from=trees extensions/microsoft-365 /opt/extensions/microsoft-365
# prawo is a CLI and nothing else (contributes.bin → bin/prawo over its dist/): Polish acts from the Sejm's ELI API and
# rulings from SAOS, fetch and JSON like google-workspace, with PDFs read through the image's fileq.
COPY --from=trees extensions/prawo /opt/extensions/prawo
# EVERY AGENT CLI THESE PACKS CONTRIBUTE (contributes.bin), made runnable. The daemon prepends their directories
# to the agent's PATH every turn, and PATH resolution skips a file with no execute bit — so all three shipped as
# mode 644, resolved to nothing, and failed the moment the agent took the skill at its word. Done here rather
# than as `--chmod` on the COPYs above, because those copy whole deployed trees and would hand the exec bit to
# every file in node_modules with them. A new pack that ships a `bin` belongs on this line.
RUN chmod +x /opt/extensions/discord/bin/* /opt/extensions/whatsapp/bin/* /opt/extensions/google-workspace/bin/* /opt/extensions/microsoft-365/bin/* /opt/extensions/imap/bin/* /opt/extensions/prawo/bin/*
