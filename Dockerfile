FROM node:22-alpine

WORKDIR /app

# koffi (used by tlsclientwrapper) needs libc++ on alpine
RUN apk add --no-cache libstdc++

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
