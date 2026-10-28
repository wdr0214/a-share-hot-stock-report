FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=80 \
    WECHAT_BIND=0.0.0.0 \
    WECHAT_AUTH_MODE=cloudrun \
    WECHAT_STATE_BACKEND=github
WORKDIR /app
COPY etf-article.mjs draft-client.mjs github-store.mjs server.mjs cli.mjs ./
EXPOSE 80
CMD ["node", "server.mjs"]
