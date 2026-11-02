# FROM mcr.microsoft.com/devcontainers/base:bookworm
# 0.9G

# FROM mcr.microsoft.com/devcontainers/python:3.10
# 2.9G

FROM mcr.microsoft.com/devcontainers/base:ubuntu24.04
# 0.8G

RUN apt update && apt-get install -y python3 npm fonts-noto-cjk fonts-wqy-microhei fonts-wqy-zenhei
RUN ln -s /usr/bin/python3 /usr/bin/python

RUN wget -O /usr/local/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt install -y /usr/local/chrome.deb

RUN curl -L -o /usr/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
RUN chmod +x /usr/bin/cloudflared

# RUN cd /workspaces/bt && npm i && ./build.sh && ./run.sh start