ARG BUILD_FROM
FROM $BUILD_FROM
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json /app/
RUN npm install --omit=dev --no-audit --no-fund
COPY bridge.js /app/
CMD ["node", "/app/bridge.js"]
