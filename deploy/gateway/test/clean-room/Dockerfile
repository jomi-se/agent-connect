# Build context is a temporary directory containing only this test kit and fixture.
FROM docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5 AS docker-cli
FROM node:26-bookworm@sha256:a546d3f8acd2af4382668a7e6acd3bc4418e6a27478373e3246f8162f5181509
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/acceptance
COPY package.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install --ignore-scripts --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright /opt/acceptance
COPY run.mjs relay.mjs owner-terminal.mjs mock-model.mjs codex-config.toml seed-codex.mjs ./
ENTRYPOINT ["node", "/opt/acceptance/run.mjs"]
