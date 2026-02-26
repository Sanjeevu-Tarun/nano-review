FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install
# No need to install chromium separately - it's in the base image
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
