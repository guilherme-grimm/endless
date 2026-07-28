# syntax=docker/dockerfile:1

# ---------- build ----------
FROM oven/bun:1-alpine AS build
WORKDIR /app

# Dependencies first, so this layer survives source edits. The project has no
# runtime dependencies at all, but keeping the step means adding one later does
# not silently break the build.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json index.html ./
COPY src ./src
RUN bun run build

# ---------- runtime ----------
# The output is entirely static: every pixel is generated in the browser, so
# there is nothing for an application server to do at runtime.
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
