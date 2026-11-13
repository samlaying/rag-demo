# 部署：免费后端方案（2026-11）

这个项目是 **Node 常驻进程 + SSE 流式 + 4.6MB 本地索引**，所以纯静态托管（GitHub Pages）只能跑演示数据，实时问答必须有一个能跑 Node 的后端。

下面按“改动量”排序。

## 结论

| 需求 | 推荐 |
|---|---|
| 今天就要跑起来，不想改代码 | **Render Free** |
| 不想绑卡 | **Koyeb Free** |
| 要稳、要给老板演示 | **Google Cloud Run**（需绑卡） |
| 长期最优、流量大 | **Cloudflare Workers**（需改写服务端） |
| 国内访问 | 阿里云函数计算 FC / 腾讯 CloudBase（需实名，免费期短） |
| 不建议 | Vercel Hobby（禁止商用）、HF Docker Space（已转收费） |

## 免费额度对比

| 平台 | 免费额度 | 关键限制 | 代码改动 |
|---|---|---|---|
| **Render** | 512MB / 0.1 CPU，750 小时/月 | 15 分钟无流量休眠，冷启动约 1 分钟 | 无（本仓库已适配） |
| **Koyeb** | 1 个 Web Service，512MB / 0.1 vCPU / 2GB SSD | 1 小时无流量缩容到 0，仅 Frankfurt / Washington | 无（Dockerfile 已带） |
| **Google Cloud Run** | 200 万请求/月，18 万 vCPU-秒，36 万 GiB-秒 | 需绑定结算账号；缩容到 0 有秒级冷启动 | 无（Dockerfile 已带） |
| **Cloudflare Workers** | 10 万请求/天，64MiB 包体，10ms CPU/次 | 无 `fs`/`http`，需改写为 fetch handler | 约半天 |
| **Deno Deploy** | 100 万请求/月，20GB 流量，15 CPU-小时 | 需从 Node 迁到 Deno（大部分兼容） | 约半天 |
| 阿里云函数计算 FC | 15 万 CU/月，最长 3 个月 | 需实名；自定义域名需备案 | 中 |
| 腾讯云 CloudBase | 3000 资源点/月（试用） | 资源点限制，长期不免费 | 中 |
| Vercel Hobby | 有免费额度 | **明确禁止商用**，公司项目不要用 | 低 |
| Hugging Face Spaces | 静态免费 | **Docker / Gradio Space 已要求 PRO** | — |

> 免费政策会变，上线前以各平台官方 pricing 页为准。以上为 2026-11 检索结果。

## 方案 A：Render（推荐，10 分钟）

仓库里已经放了 `render.yaml`，支持 Blueprint 一键部署。

1. 打开 [Render Dashboard](https://dashboard.render.com/) → **New** → **Blueprint**
2. 连接 GitHub 仓库 `samlaying/rag-demo`
3. 应用 `render.yaml`
4. 在环境变量里填 `SILICONFLOW_API_KEY`（不要写进仓库）
5. 部署完成后访问 `https://<service>.onrender.com`

注意：

- 免费实例 15 分钟无请求会休眠，**演示前先打开一次预热**
- 冷启动约 1 分钟，页面会先转圈
- 想让服务常驻，可以用 UptimeRobot 每 10 分钟 ping 一次 `/api/health`（免费额度够）

## 方案 B：Koyeb（不绑卡）

1. [Koyeb](https://app.koyeb.com/) → Create Service → GitHub
2. 选择 `samlaying/rag-demo`
3. Builder 选 **Dockerfile**
4. Port 填 `3000`，Health check 填 `/api/health`
5. 环境变量填 `SILICONFLOW_API_KEY`
6. Instance 选 **Free**，Region 选 Frankfurt 或 Washington

免费实例 1 小时无流量才缩容，比 Render 更适合演示日。

## 方案 C：Google Cloud Run（最稳）

```bash
gcloud run deploy rag-demo \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 3000 \
  --set-env-vars SILICONFLOW_API_KEY=sk-...
```

生产建议把 Key 放 Secret Manager：

```bash
gcloud secrets create siliconflow-key --data-file=-
gcloud run deploy rag-demo --source . --set-secrets SILICONFLOW_API_KEY=siliconflow-key:latest
```

免费额度：200 万请求/月，个人 demo 基本用不完。需要绑定结算账号。

## 方案 D：Cloudflare Workers（长期最优，但要改写）

- 免费 10 万请求/天，无冷启动，全球边缘
- 2026-09 起包体限制统一为 **64MiB 未压缩**，4.6MB 索引可以直接内联/放 KV
- 需要把 `node:http` 改成 `export default { fetch }`，SSE 用 `ReadableStream`
- 10ms CPU/次足够：54 条 × 4096 维余弦约 22 万次乘加，远低于 10ms；模型调用是 I/O，不计 CPU
- 索引不要用 `fs` 读，构建时 `import index from './data/index.json'` 或放 KV

## 国内访问

- 阿里云 FC：每月 15 万 CU，最长 3 个月；中国内地 20GB 流量/月，需实名
- 腾讯 CloudBase：3000 资源点/月试用
- 自定义域名在国内节点需要 ICP 备案；香港/新加坡节点不需要备案，但延迟一般

## 运维要点

- **Key 只在服务端环境变量**，前端永远不出现
- 索引已预构建在 `data/index.json`（4.6MB），冷启动不会重新 embedding
- 健康检查：`GET /api/health`
- 免费实例休眠：演示前预热；或加定时 ping
- 日志：先用平台自带日志，后面接 Langfuse
