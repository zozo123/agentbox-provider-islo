# syntax=docker/dockerfile:1.7

ARG AGENTBOX_VERSION=0.24.6

FROM node:20-bookworm-slim AS agentbox
ARG AGENTBOX_VERSION
RUN npm pack "@madarco/agentbox@${AGENTBOX_VERSION}" --pack-destination /tmp \
    && mkdir -p /tmp/agentbox \
    && tar -xzf /tmp/madarco-agentbox-*.tgz -C /tmp/agentbox

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/home/vscode/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        procps \
        rsync \
        sudo \
        tmux \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod -n vscode node \
    && usermod -l vscode -d /home/vscode -m node \
    && printf 'vscode ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && mkdir -p /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox \
    && chown -R vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox

COPY --from=agentbox /tmp/agentbox/package/runtime/_shared/ctl.cjs /usr/local/bin/agentbox-ctl
RUN chmod 0755 /usr/local/bin/agentbox-ctl

WORKDIR /workspace
