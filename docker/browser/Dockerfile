# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim AS agent-build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /build
COPY . .
RUN npm ci --ignore-scripts --workspace @chrome-fleet/browser-agent --include-workspace-root \
 && npm run build --workspace @chrome-fleet/browser-agent

FROM node:24.22.0-bookworm-slim
LABEL org.opencontainers.image.licenses="Apache-2.0" org.opencontainers.image.source="https://github.com/Scisaga/chrome-fleet"
ARG TARGETARCH
ARG CHROME_VERSION=155.0.8059.79
ARG CHROME_DISTRIBUTION=google
LABEL chrome-fleet.browser="true" chrome-fleet.chrome.version="${CHROME_VERSION}" chrome-fleet.chrome.distribution="${CHROME_DISTRIBUTION}"
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOME=/home/fleet DISPLAY=:99 XDG_DATA_HOME=/state XDG_RUNTIME_DIR=/tmp/fleet-runtime \
    CHROME_PATH=/usr/bin/google-chrome STATE_ROOT=/state
RUN test "${TARGETARCH:-amd64}" = amd64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg jq unzip \
    xvfb openbox x11vnc novnc websockify tigervnc-tools x11-utils dbus dbus-x11 \
    gnome-keyring libsecret-tools libglib2.0-bin python3 fonts-noto-cjk fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
 && rm -rf /var/lib/apt/lists/*
COPY docker/browser/install-chrome.sh /usr/local/bin/fleet-install-chrome
RUN chmod 0755 /usr/local/bin/fleet-install-chrome \
 && /usr/local/bin/fleet-install-chrome "$CHROME_DISTRIBUTION" "$CHROME_VERSION" \
 && groupmod --new-name fleet node \
 && usermod --login fleet --home /home/fleet --move-home node \
 && mkdir -p /state/chrome /state/keyrings /state/downloads /home/fleet/.cache \
 && chown -R 1000:1000 /state /home/fleet \
 && chmod 0700 /state /state/chrome /state/keyrings /state/downloads
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 XDG_CONFIG_HOME=/state/config
WORKDIR /app
COPY --from=agent-build /build/LICENSE /build/NOTICE /app/
COPY --from=agent-build /build/node_modules /app/node_modules
COPY --from=agent-build /build/apps/browser-agent/dist /app/apps/browser-agent/dist
COPY --from=agent-build /build/apps/browser-agent/package.json /app/apps/browser-agent/package.json
COPY docker/browser/entrypoint.sh /usr/local/bin/fleet-entrypoint
COPY docker/browser/session.sh /usr/local/bin/fleet-session
COPY docker/browser/vnc-reload.sh /usr/local/bin/fleet-vnc-reload
RUN chmod 0755 /usr/local/bin/fleet-entrypoint /usr/local/bin/fleet-session /usr/local/bin/fleet-vnc-reload
RUN apt-get update \
 && apt-get install -y --no-install-recommends xclip wmctrl \
 && rm -rf /var/lib/apt/lists/*
USER 1000:1000
EXPOSE 8092 6080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/fleet-entrypoint"]
