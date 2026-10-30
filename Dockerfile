# One image, every role. Pick the role with the command, e.g.
#   docker run IMAGE                                  -> API
#   docker run IMAGE npx tsx src/notification/worker.ts
# Base image pinned by digest: node 22.22 on alpine 3.24, tag last pushed 2026-06-16.
FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx esbuild src/web/form.ts --bundle --format=esm --outfile=public/form.js

FROM node:22.22-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd
WORKDIR /app
ENV NODE_ENV=production
# Inside a container the API must listen on all interfaces; publish the port deliberately.
ENV HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY migrations ./migrations
COPY src ./src
COPY public/index.html ./public/index.html
COPY --from=build /app/public/form.js ./public/form.js
USER node
EXPOSE 3100
CMD ["npx", "tsx", "src/api/server.ts"]
