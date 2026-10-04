# Build context is shipped by the launcher, plus the platform's static Linux runner.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /opt/adapters
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && cpu=$(node -p process.arch) \
    && ln -sf "../../claude-code-linux-$cpu/claude" node_modules/@anthropic-ai/claude-code/bin/claude.exe \
    && chmod 755 "node_modules/@anthropic-ai/claude-code-linux-$cpu/claude" \
    && ln -sf ../@anthropic-ai/claude-code/bin/claude.exe node_modules/.bin/claude \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-* \
    && find node_modules/@openai -name codex-voice-host -delete \
    && find node_modules/@openai -name codex-code-mode-host -delete

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# Curated tools: edit this list when the product's baseline needs change.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils sed grep gawk git ripgrep fd-find jq curl ca-certificates \
    python3 less procps unzip \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/adapters/node_modules/.bin:$PATH
ENV CLAUDE_CODE_EXECUTABLE=/opt/adapters/node_modules/@anthropic-ai/claude-code/bin/claude.exe
COPY --from=dependencies /opt/adapters /opt/adapters
COPY session-runner /usr/local/bin/session-runner
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY egress-proxy.mjs /opt/agent-connect/egress-proxy.mjs
COPY mock-codex-config.toml /opt/agent-connect/mock-codex-config.toml
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
