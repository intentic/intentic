# The baked embedding + reranker models behind `iq ask` (~57 MiB, fetched from HF by prepare-image-trees.sh
# into the `trees` context; IQ_MODEL_DIR points at /opt/iq-models in every image). Absent → iq degrades to
# lexical search, never fetches at runtime — which is exactly what the core image does. A trees COPY rather
# than an in-build RUN fetch, which makes this pack BAKE-ONLY: the COPY layer re-runs cheap on every commit
# where a post-trees download would re-pull from HF in every pipeline.
COPY --from=trees iq-models /opt/iq-models
