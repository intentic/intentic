# castd, each browser window's media daemon (_sandbox/castd): its picture, sound and the person's input on a socket of
# its own that netd relays the editor's media socket to. The tree is castd's own build (build.Dockerfile there, run by
# _tools/scripts/image/build-castd.sh on the image's Debian release): /opt/castd/bin/castd, its patched Xvfb beside it
# (XTEST scroll axes, for a trackpad's smooth scrolling) and its patched libx264 in /opt/castd/lib, which castd's rpath
# names and falls back from to Debian's libx264-164.
# Carried into the `trees` context by prepare-image-trees.sh as a static layer root, like the speech model, so the pack
# is BAKE-ONLY and an update whose castd did not change reuses the layer. The libraries castd links, PulseAudio and
# xsettingsd come with the browser pack, which overlays can add; without this pack (an overlay's browser, or an image
# from before castd) the daemon finds no castd and shows every window the old way (browser/media/castd.ts).
COPY --link --from=trees layers/castd/ /
