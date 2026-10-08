# The dictation model, baked so the composer's microphone works the moment it is pressed: NVIDIA Parakeet TDT 0.6B
# v3 as k2-fsa's int8 sherpa-onnx export (~640 MiB on disk), which hears 25 European languages at roughly 30x real
# time on two cores (src/speech/speech-models.ts pins it). The runtime is not here: sherpa-onnx-node is an ordinary
# dependency of the daemon, so every image, core included, can hear; this pack only saves the first press a download.
# An image without it (core, or an older one) fetches the same files into the workspace cache in the background
# while the composer shows the progress. Whisper, which hears the other ~75 languages, is never baked: it is fetched
# the first time someone dictates in one of them.
# Fetched by prepare-image-trees.sh (scripts/fetch-speech-models.mjs, digest-checked) into the `trees` context, so the
# pack is BAKE-ONLY like `semantic`: the COPY layer is the same bytes on every commit, so a pull after an update
# reuses it instead of downloading the model again.
# Licence: CC-BY-4.0 (NVIDIA); the attribution travels in the directory with it.
COPY --from=trees --link speech-models /opt/speech-models
