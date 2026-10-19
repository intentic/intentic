# The baked embedding + reranker models behind `iq ask` (~57 MiB, fetched from HF by prepare-image-trees.sh
# into the `trees` context; IQ_MODEL_DIR points at /opt/iq-models in every image). Absent → iq degrades to
# lexical search, never fetches at runtime — which is exactly what the core image does. A trees COPY rather
# than an in-build RUN fetch, which makes this pack BAKE-ONLY. It copies a STATIC LAYER ROOT (prepare-image-trees.sh
# `static_layer`: the whole path from /, every entry at one fixed time) with --link, so the layer is the same bytes on
# every commit and an update reuses it, and it splices above the per-commit trees (packs.ts `postTrees`).
COPY --link --from=trees layers/iq-models/ /
