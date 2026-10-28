# Install the in-process Cursor SDK only on the owner's machine: its licence grants no redistribution in published images/profiles.
# prepare-image-trees.sh removes SDK/platform packages; Connect bootstraps login, then the credential-gated overlay preserves the install.
# Use a separate prefix to avoid npm mutating the daemon's pnpm tree; cursor-sdk.ts resolves it through the manifest.
# Keep the SDK pin in lockstep with the catalog; packs.integration.test.ts checks runtime/type compatibility.
RUN --mount=type=cache,target=/root/.npm \
    npm install --prefix /opt/cursor-sdk --no-save --no-package-lock @cursor/sdk@1.2.0 \
    && node -e "process.stdout.write(require('/opt/cursor-sdk/node_modules/@cursor/sdk/package.json').version + '\n')"
