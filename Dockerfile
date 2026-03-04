FROM node:22-alpine

WORKDIR /app

# Install curl-impersonate (lexiforest fork v1.2.2 — active fork with musl builds)
# Downloaded at BUILD TIME — zero runtime downloads at deploy time.
RUN apk add --no-cache ca-certificates wget tar && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH_TAG="x86_64-linux-musl"; \
    elif [ "$ARCH" = "aarch64" ]; then ARCH_TAG="aarch64-linux-musl"; \
    else echo "Unsupported arch: $ARCH" && exit 1; fi && \
    wget -q "https://github.com/lexiforest/curl-impersonate/releases/download/v1.2.2/curl-impersonate-v1.2.2.${ARCH_TAG}.tar.gz" \
         -O /tmp/ci.tar.gz && \
    mkdir -p /tmp/ci && \
    tar -xzf /tmp/ci.tar.gz -C /tmp/ci && \
    echo "--- extracted files ---" && ls /tmp/ci/ && \
    find /tmp/ci -type f -name "curl*" -exec install -m755 {} /usr/local/bin/curl_chrome131 \; && \
    rm -rf /tmp/ci /tmp/ci.tar.gz && \
    curl_chrome131 --version

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
