FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/chat.sqlite
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]
