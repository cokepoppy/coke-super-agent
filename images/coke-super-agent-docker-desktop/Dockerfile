ARG CSA_DESKTOP_BASE_IMAGE=coke-super-agent-desktop:local
FROM ${CSA_DESKTOP_BASE_IMAGE}

COPY runtime/ /opt/csa-agent-runtime/
COPY --chown=0:0 --chmod=0644 computer-plugin.mjs remote-terminal-plugin.mjs superagent-ticket-plugin.mjs /opt/csa-agent-runtime/
COPY --chmod=0755 start-csa-desktop.sh /usr/local/bin/start-csa-docker-desktop

EXPOSE 6080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-csa-docker-desktop"]
