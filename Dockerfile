FROM node:22-alpine

WORKDIR /app

# curl-impersonate needs bash (scripts use #!/usr/bin/env bash)
# Install at BUILD TIME — binaries are shell scripts wrapping curl with preset flags
RUN apk add --no-cache ca-certificates wget tar bash && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then TAG="x86_64-linux-musl"; \
    else TAG="aarch64-linux-musl"; fi && \
    wget -q "https://github.com/lexiforest/curl-impersonate/releases/download/v1.2.2/curl-impersonate-v1.2.2.${TAG}.tar.gz" \
         -O /tmp/ci.tar.gz && \
    tar -xzf /tmp/ci.tar.gz -C /usr/local/bin && \
    rm /tmp/ci.tar.gz && \
    chmod +x /usr/local/bin/curl_chrome131 && \
    curl_chrome131 --version && echo "curl-impersonate OK"

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
