FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY client ./client

EXPOSE 8080

WORKDIR /app/server
CMD ["node", "index.js"]