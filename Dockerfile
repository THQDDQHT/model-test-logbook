# 模型测试记录台 · Model Test Logbook
#
# 零依赖镜像：只用 Node 内置的 http / node:sqlite，不需要 npm install。
#   docker build -t model-test-logbook .
#   docker run -d -p 8788:8788 -v "$PWD/data:/app/data" model-test-logbook

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8788 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 运行只需要这几个文件，测试与依赖都不进镜像
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY examples ./examples
COPY start.sh README.md ./

# 数据目录先建好并交给 node 用户，容器内以非 root 运行
RUN mkdir -p /app/data/files && chown -R node:node /app

USER node

VOLUME ["/app/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 首次启动会写入 3 条示例记录，加 --no-seed 可跳过
CMD ["node", "server.mjs"]
