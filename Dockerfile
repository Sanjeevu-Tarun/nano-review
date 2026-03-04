FROM node:22-alpine

WORKDIR /app

# Install curl-impersonate-chrome — patched curl that mimics Chrome 131 TLS fingerprint.
# Downloaded at BUILD TIME (Docker build has internet access) so zero runtime downloads.
# Binary is bundled in the image — no outbound fetch needed at runtime.
RUN apk add --no-cache ca-certificates libcurl curl tar && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH_TAG="x86_64"; else ARCH_TAG="aarch64"; fi && \
    wget -q "https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.${ARCH_TAG}-linux-musl.tar.gz" \
         -O /tmp/curl-impersonate.tar.gz && \
    tar -xzf /tmp/curl-impersonate.tar.gz -C /usr/local/bin && \
    rm /tmp/curl-impersonate.tar.gz && \
    chmod +x /usr/local/bin/curl_chrome131 && \
    # Verify it works
    curl_chrome131 --version

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

