FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js auth.js ./
COPY public ./public

USER node
EXPOSE 4173
CMD ["node", "server.js"]
