# Per-session sandbox image for the ACP gateway spike.
# Build context: experiments/acp-gateway
# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --bin session_runner \
    && cp target/release/session_runner /session_runner

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/adapters
COPY adapters/package.json adapters/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
ENV PATH=/opt/adapters/node_modules/.bin:$PATH
COPY --from=build /session_runner /usr/local/bin/session_runner
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY sandbox/codex-config.toml /opt/spike/codex-config.toml
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
