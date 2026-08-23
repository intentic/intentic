# Cursor's own agent runtime — `@cursor/sdk`, which the daemon loads IN PROCESS to serve a Cursor turn
# (cursor/cursor-agent.ts). Unlike every other provider pack this installs a MODULE rather than a binary,
# because Cursor's runtime is a library and not a CLI.
#
# THE ONLY CLOSED-SOURCE PACK, and the reason it is a pack at all. Its licence is "all rights reserved, use
# subject to Cursor's Terms of Service", which grants no redistribution — so it must never ride a published
# image, where pulling the image would redistribute it to everyone whether or not they have a Cursor account.
# prepare-image-trees.sh prunes it and its platform packages out of the daemon tree, and this fragment puts one
# copy back on the OWNER'S machine, in the overlay rebuild they approve after connecting a Cursor account
# (environment/provider-packs.ts gates it on that credential being on disk). Deliberately absent from
# packs/profiles.json for the same reason: no profile may bake it.
#
# A PREFIX OF ITS OWN rather than an install into the daemon's deployed tree: that tree is pnpm's, laid out as
# a content-addressed store plus symlinks, and npm writing a flat package into the middle of it is the kind of
# thing that works until it does not. Standing apart also keeps this fragment cache-stable above the image's
# tree COPYs, so a source change never re-runs the download. cursor/cursor-sdk.ts resolves the module from here
# by reading its own manifest, so nothing depends on the layout npm happens to produce.
#
# Pinned in lockstep with the pnpm-workspace.yaml catalog entry — a version skew shows up as SDK types the
# daemon was compiled against not matching the module it loads; packs.integration.test.ts holds the two in step.
# ponytail: bump together with the @cursor/sdk catalog pin.
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/cursor-sdk --no-save --no-package-lock @cursor/sdk@1.0.28 \
    && node -e "process.stdout.write(require('/opt/cursor-sdk/node_modules/@cursor/sdk/package.json').version + '\n')"
