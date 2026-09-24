# One process serves the page and the game, so a host that gives the app a
# single public port (Railway and friends) has nothing to route around.
FROM node:22-alpine

WORKDIR /app

# Dependencies first: they change far less often than the game does.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Railway sets PORT itself and overrides this; the default is for `docker run`.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
