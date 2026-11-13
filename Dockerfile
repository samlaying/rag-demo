FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY package.json rag-demo.mjs ./
COPY src ./src
COPY web ./web
COPY data ./data

EXPOSE 3000
USER node

CMD ["node", "src/server.mjs"]
