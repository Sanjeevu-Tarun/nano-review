FROM node:22-slim

WORKDIR /app

# tlsclientwrapper uses koffi (FFI to Go shared lib) — no extra system deps needed
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
