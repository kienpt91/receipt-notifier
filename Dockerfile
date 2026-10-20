# One image, every role. Pick the role with the command, e.g.
#   docker run IMAGE                                  -> API
#   docker run IMAGE npx tsx src/notification/worker.ts
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npx esbuild src/web/form.ts --bundle --format=esm --outfile=public/form.js

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY migrations ./migrations
COPY src ./src
COPY public/index.html ./public/index.html
COPY --from=build /app/public/form.js ./public/form.js
USER node
EXPOSE 3100
CMD ["npx", "tsx", "src/api/server.ts"]
