#
# Build the tenant runtime into the OCI image. CubeSandbox later snapshots this
# image as a template; the tenant VM does not run apt to prepare its desktop.

ARG CUBE_BASE_IMAGE=ghcr.io/tencentcloud/cubesandbox-base:2026.16
FROM ${CUBE_BASE_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=http://mirrors.tencent.com/ubuntu-ports
ARG DSH_RUNTIME_FINGERPRINT
ARG DSH_PACKAGE_LOCK_SHA256
ARG DSH_RUNTIME_WHEEL_SHA256
ARG PI_RUNTIME_FINGERPRINT
ARG NODE_MAJOR=24

ENV LANG=C.UTF-8 \
    DISPLAY=:1 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=800 \
    SCREEN_DEPTH=24 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    DESKTOP_USER=user \
    XDG_SESSION_TYPE=x11 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    GALLIUM_DRIVER=llvmpipe

RUN set -eux; \
    if [ -n "${APT_MIRROR}" ] && [ -f /etc/apt/sources.list ]; then \
      sed -i \
        -e "s|http://archive.ubuntu.com/ubuntu|${APT_MIRROR}|g" \
        -e "s|http://ports.ubuntu.com/ubuntu-ports|${APT_MIRROR}|g" \
        -e "s|http://security.ubuntu.com/ubuntu|${APT_MIRROR}|g" \
        /etc/apt/sources.list; \
    fi; \
    echo 'apt_network=direct'; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 update; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 -y --no-install-recommends install \
      ca-certificates curl dbus dbus-user-session dbus-x11 fonts-dejavu-core \
      fonts-noto-cjk gnupg iproute2 locales novnc procps python3 python3-pip \
      python3-tk python3-venv python3-xlib scrot sudo util-linux websockify \
      wmctrl x11-utils x11-xserver-utils x11vnc xclip xdotool xfce4 \
      xfce4-terminal xserver-xorg-core xserver-xorg-video-dummy xvfb; \
    rm -rf /var/lib/apt/lists/*

# Install supported system Node.js/npm for the interactive terminal. The
# Agent Runtime keeps its separately pinned ARM64 Node binary under /opt.
RUN set -eux; \
    curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location \
      --retry 4 --connect-timeout 15 --max-time 180 \
      "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource-setup.sh; \
    bash /tmp/nodesource-setup.sh; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 update; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 -y --no-install-recommends install nodejs; \
    node --version; npm --version; \
    rm -f /tmp/nodesource-setup.sh; \
    rm -rf /var/lib/apt/lists/*

# Google publishes a native ARM64 Debian package. Download and install it
# while building the image; each tenant clone only starts the browser process.
RUN set -eux; \
    test "$(dpkg --print-architecture)" = arm64; \
    curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location \
      --retry 5 --connect-timeout 20 --max-time 600 \
      https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb \
      -o /tmp/google-chrome-stable_arm64.deb; \
    test "$(dpkg-deb --field /tmp/google-chrome-stable_arm64.deb Architecture)" = arm64; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 update; \
    apt-get -o Acquire::http::Proxy=false -o Acquire::https::Proxy=false -o Acquire::Retries=3 -o Acquire::http::Timeout=120 -o Acquire::https::Timeout=120 -y --no-install-recommends \
      install /tmp/google-chrome-stable_arm64.deb; \
    google-chrome-stable --version; \
    rm -f /tmp/google-chrome-stable_arm64.deb; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if ! getent passwd 1000 >/dev/null; then \
      useradd --uid 1000 --create-home --shell /bin/bash "${DESKTOP_USER}"; \
    fi; \
    desktop_user="$(getent passwd 1000 | cut -d: -f1)"; \
    echo "${desktop_user} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/csa-desktop; \
    chmod 0440 /etc/sudoers.d/csa-desktop; \
    visudo -cf /etc/sudoers.d/csa-desktop >/dev/null; \
    install -d -m 0755 /etc/csa-super-agent /opt/csa-agent-runtime \
      /var/lib/csa-agent-runtime /var/lib/csa-desktop /workspace/tasks \
      /workspace/.csa-super-agent/runs /workspace/.desktop-home/.config/chromium; \
    chown -R 1000:1000 /workspace

COPY csa-desktop-session.sh /usr/local/bin/csa-desktop-session
COPY desktop-image.json /etc/csa-super-agent/desktop-image.json

# Bind-mounted build inputs are extracted in this RUN layer only. The 170+ MiB
# archives are not copied into an image layer and are absent from the result.
RUN --mount=type=bind,source=dsh-runtime-linux-arm64.tar.gz,target=/tmp/dsh-runtime-linux-arm64.tar.gz,readonly \
    --mount=type=bind,source=pi-runtime-linux-arm64.tar.gz,target=/tmp/pi-runtime-linux-arm64.tar.gz,readonly \
    set -eux; \
    echo "${DSH_RUNTIME_FINGERPRINT}" | grep -Eq '^[a-f0-9]{64}$'; \
    echo "${DSH_PACKAGE_LOCK_SHA256}" | grep -Eq '^[a-f0-9]{64}$'; \
    echo "${DSH_RUNTIME_WHEEL_SHA256}" | grep -Eq '^[a-f0-9]{64}$'; \
    echo "${PI_RUNTIME_FINGERPRINT}" | grep -Eq '^[a-f0-9]{64}$'; \
    tar --no-same-owner -xzf /tmp/dsh-runtime-linux-arm64.tar.gz -C /opt/csa-agent-runtime; \
    test "$(cat /opt/csa-agent-runtime/runtime-key.sha256)" = "${DSH_RUNTIME_FINGERPRINT}"; \
    test "$(cat /opt/csa-agent-runtime/runtime-wheel.sha256)" = "${DSH_RUNTIME_WHEEL_SHA256}"; \
    printf '%s\n' "${DSH_RUNTIME_FINGERPRINT}" > /var/lib/csa-agent-runtime/runtime-key.expected.sha256; \
    printf '%s\n' "${DSH_RUNTIME_FINGERPRINT}" > /var/lib/csa-agent-runtime/runtime-key.sha256; \
    printf '%s\n' "${DSH_PACKAGE_LOCK_SHA256}" > /var/lib/csa-agent-runtime/package-lock.sha256; \
    printf '%s\n' "${DSH_RUNTIME_WHEEL_SHA256}" > /var/lib/csa-agent-runtime/runtime-wheel.sha256; \
    date -u +%FT%TZ > /var/lib/csa-agent-runtime/ready; \
    pi_runtime_key_prefix="$(printf '%s' "${PI_RUNTIME_FINGERPRINT}" | cut -c1-16)"; \
    pi_runtime_dir="/opt/csa-agent-runtime/pi-${pi_runtime_key_prefix}"; \
    install -d -m 0755 "$pi_runtime_dir"; \
    tar --no-same-owner -xzf /tmp/pi-runtime-linux-arm64.tar.gz -C "$pi_runtime_dir"; \
    test -s "$pi_runtime_dir/node_modules/@mariozechner/pi-coding-agent/package.json"; \
    test -s "$pi_runtime_dir/node_modules/typebox/package.json"; \
    test "$(node -p 'require(process.argv[1]).version' "$pi_runtime_dir/node_modules/@mariozechner/pi-coding-agent/package.json")" = 0.73.1; \
    printf '%s\n' "${PI_RUNTIME_FINGERPRINT}" > /var/lib/csa-agent-runtime/pi-runtime-key.sha256; \
    printf '%s\n' "${PI_RUNTIME_FINGERPRINT}" > "$pi_runtime_dir/runtime-key.sha256"; \
    chmod -R a+rX /opt/csa-agent-runtime /var/lib/csa-agent-runtime; \
    chmod 0755 /usr/local/bin/csa-desktop-session; \
    test -x /opt/csa-agent-runtime/bin/node; \
    test -s /opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs; \
    test -x /opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64; \
    test -x /opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg; \
    test -x "$(command -v google-chrome-stable)"; \
    node --version | grep -E '^v24\.'; \
    npm --version; python3 --version

EXPOSE 49983 6080 5900

# Keep the cubesandbox-base ENTRYPOINT so envd remains available to the SDK.
# Desktop and Chrome are started on demand by the control-plane bootstrap after
# a tenant microVM is created, which keeps image-to-template creation simple.
CMD ["sleep", "infinity"]
