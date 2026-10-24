# Build context is shipped by the launcher, plus the platform's static Linux runner.
# Setup builds the harness-free `base` stage and layers the harness versions it
# resolved on top, so a new Claude Code or Codex needs no gateway release.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
# Curated tools: edit this list when the product's baseline needs change.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils sed grep gawk git ripgrep fd-find jq curl ca-certificates \
    python3 less procps unzip \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/adapters/node_modules/.bin:$PATH
ENV CLAUDE_CODE_EXECUTABLE=/opt/adapters/node_modules/@anthropic-ai/claude-code/bin/claude.exe
COPY install-harnesses.sh /usr/local/lib/agent-connect/install-harnesses.sh
COPY session-runner /usr/local/bin/session-runner
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY egress-proxy.mjs /opt/agent-connect/egress-proxy.mjs
COPY mock-codex-config.toml /opt/agent-connect/mock-codex-config.toml
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# A plain build of this context (checkout verification) gets npm's latest harnesses.
FROM base
USER root
RUN ["sh", "/usr/local/lib/agent-connect/install-harnesses.sh"]
USER node
