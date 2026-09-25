# syntax=docker/dockerfile:1

# 公共依赖层：web 与 verify 共用
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 验收服务：运行 Vitest 全量验收（含 20 万灯具性能用例），失败即非零退出
FROM deps AS verify
COPY . .
CMD ["npm", "run", "verify"]

# 静态构建
FROM deps AS build
COPY . .
RUN npm run build

# 发布：纯静态站点，不调用任何外部服务
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
