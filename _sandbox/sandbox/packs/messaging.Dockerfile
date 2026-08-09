# The messaging gateway runtimes — deployed trees from the `trees` build context, so this pack is BAKE-ONLY
# (profiles can include it; an overlay rebuild cannot, and the daemon surfaces "not in this image" for a
# messaging connector on a core image instead — extensions/extension-readiness.ts). Their MANIFESTS are baked
# in every image by the core Dockerfile so the capability cards exist either way; these COPYs put the runnable
# gateways behind them.
COPY --from=trees extensions/discord /opt/extensions/discord
# Same glibc rationale as the daemon tree's node-pty rebuild — the discord gateway's voice stack compiles opus
# from source, linked against whatever host ran pnpm deploy.
RUN cd /opt/extensions/discord/node_modules/.pnpm/@discordjs+opus@*/node_modules/@discordjs/opus \
    && rm -rf prebuild build-tmp-napi-v3 \
    && npm run install \
    && npm cache clean --force
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
# EVERY AGENT CLI THESE PACKS CONTRIBUTE (contributes.bin), made runnable. The daemon prepends their directories
# to the agent's PATH every turn, and PATH resolution skips a file with no execute bit — so all three shipped as
# mode 644, resolved to nothing, and failed the moment the agent took the skill at its word. Done here rather
# than as `--chmod` on the COPYs above, because those copy whole deployed trees and would hand the exec bit to
# every file in node_modules with them. A new pack that ships a `bin` belongs on this line.
RUN chmod +x /opt/extensions/discord/bin/* /opt/extensions/whatsapp/bin/* /opt/extensions/google-workspace/bin/*
