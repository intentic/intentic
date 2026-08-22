# The CUDA build of llama-server, composed into the overlay by the local-model capability's GPU option and
# NEVER baked into a published profile: the CUDA runtime libraries it keeps are hundreds of MB that only a
# sandbox with the `--gpus=all` directive can use. It REPLACES the CPU binary the llamacpp pack installed at
# the same path, which is the whole upgrade: the handler's command line doesn't change, the rebuilt binary
# simply offloads when the handler passes -ngl (it does exactly when SANDBOX_GPU says the flag rode).
# The toolkit comes from NVIDIA's own apt repo (the docker GPU fragment's keyring dance, kept in step with it),
# nvcc and the dev headers are purged after the build, and the cuBLAS/cudart runtime halves stay: unlike the
# host's driver libraries (which --gpus injects at run time), the CUDA runtime is the binary's own dependency.
# Arch spread rather than `native` — there is no GPU at build time; Turing through Hopper covers the cards the
# directive's nvidia-runtime host probe admits.
# ponytail: bump the llama.cpp pin together with llamacpp.Dockerfile, the two build one tag.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/3bf863cc.pub -o /etc/apt/keyrings/nvidia-cuda.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/nvidia-cuda.asc] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/ /" \
        > /etc/apt/sources.list.d/nvidia-cuda.list \
    && apt-get update && apt-get install -y --no-install-recommends cmake g++ make libgomp1 cuda-nvcc-12-6 cuda-cudart-dev-12-6 libcublas-dev-12-6 \
    && git clone --depth 1 --branch b10581 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp \
    && cmake -S /tmp/llama.cpp -B /tmp/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
        -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF \
        -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;90" -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc \
    && cmake --build /tmp/llama.cpp/build -j --target llama-server \
    && install /tmp/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server \
    && rm -rf /tmp/llama.cpp \
    && apt-get purge -y cmake cuda-nvcc-12-6 cuda-cudart-dev-12-6 libcublas-dev-12-6 \
    && apt-get install -y --no-install-recommends cuda-cudart-12-6 libcublas-12-6 \
    && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
