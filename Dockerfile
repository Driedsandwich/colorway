FROM node:22-slim
WORKDIR /app
# package.json* is a pattern so the build still works while the app has no package.json.
COPY server.mjs package.json* ./
COPY lib/ ./lib/
COPY public/ ./public/
# No keys, passcode or SESSION_SECRET here: the deploy step supplies APP_PASSCODE,
# SESSION_SECRET and YOUCAM_API_KEY from a secret store.
ENV NODE_ENV=production MODE=live HOST=0.0.0.0 PORT=8080 DATA_DIR=/tmp/colorway-data TRUST_PROXY=1 RETENTION_HOURS=24
USER node
CMD ["node", "server.mjs"]
