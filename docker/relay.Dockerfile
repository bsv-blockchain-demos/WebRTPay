# webrtpay-relay built from this package. The build context is the package root
# (docker-compose.yml sets it; relay.Dockerfile.dockerignore limits what is sent).
# Configured by the environment variables of server/cli.ts: PORT, HOST, PUBLIC_URLS,
# TRUSTED_IP_HEADER, STUN_URLS, TURN_PROVIDER (coturn: TURN_SECRET and TURN_URLS;
# cloudflare: CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN), TURN_TTL and the
# limits in the README.

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# @bsv/sdk is a peer dependency, installed through its devDependency pin, so --omit=dev
# leaves it out; take the copy the lockfile installed in the build stage (it has no
# dependencies of its own).
COPY --from=build /src/node_modules/@bsv/sdk ./node_modules/@bsv/sdk
COPY --from=build /src/dist ./dist
USER node
EXPOSE 8787
CMD ["node","dist/server/cli.js"]
