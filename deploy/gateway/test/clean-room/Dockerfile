# Build context is a temporary directory containing only this test kit and fixture.
FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli
FROM node:26-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/acceptance
COPY package.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm install --ignore-scripts --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright /opt/acceptance
COPY run.mjs relay.mjs owner-terminal.mjs owner-totp.mjs mock-model.mjs codex-config.toml seed-codex.mjs ./
ENTRYPOINT ["node", "/opt/acceptance/run.mjs"]
