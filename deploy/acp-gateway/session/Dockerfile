# syntax=docker/dockerfile:1
# Build context: repository root. Cross-built static runners are local artifacts.
FROM --platform=$BUILDPLATFORM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS dependencies
ARG TARGETARCH
WORKDIR /opt/adapters
COPY deploy/acp-gateway/session/package.json deploy/acp-gateway/session/package-lock.json ./
RUN case "$TARGETARCH" in amd64) cpu=x64;; arm64) cpu=arm64;; *) exit 1;; esac \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cpu="$cpu" --os=linux \
    && cp "node_modules/@anthropic-ai/claude-code-linux-$cpu/claude" node_modules/@anthropic-ai/claude-code/bin/claude.exe \
    && chmod 755 node_modules/@anthropic-ai/claude-code/bin/claude.exe

FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
ARG TARGETARCH
ENV PATH=/opt/adapters/node_modules/.bin:$PATH
COPY --from=dependencies /opt/adapters /opt/adapters
COPY dist/session-runners/${TARGETARCH}/session-runner /usr/local/bin/session-runner
COPY deploy/acp-gateway/session/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/acp-gateway/egress-proxy.mjs /opt/agent-connect/egress-proxy.mjs
COPY deploy/acp-gateway/test/fixtures/codex-config.toml /opt/agent-connect/mock-codex-config.toml
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
