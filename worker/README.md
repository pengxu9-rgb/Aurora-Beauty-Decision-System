# Aurora Vectorization Worker (Python)

这个目录用于 **离线 ETL / 向量化提取**：

- 输入：Excel/CSV（SKU 维度的成分表）
- 处理：调用 Google Gemini（LLM 做功效/风险向量，Embedding 做相似度向量）
- 输出：写入 Railway Postgres（含 pgvector）

## 1) 安装依赖

建议单独建一个 venv：

```bash
cd client
python3 -m venv .venv-worker
source .venv-worker/bin/activate
pip install -r worker/requirements.txt
```

## 2) 环境变量

基础需要两个：

- `DATABASE_URL`：Railway Postgres 连接串
- `GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）：Google Gemini API Key

为了解决 **Social(60%) 冷启动**（没有爬虫时），可选再加一个：

- `OPENAI_API_KEY`：用于调用 `gpt-4o` 做“舆情模拟”（写入 `social_stats` 表）

你可以放在 `client/.env`（本项目已忽略 `.env`，不会提交到 git）：

```bash
DATABASE_URL='postgresql://...'
GEMINI_API_KEY='...'
OPENAI_API_KEY='...'
```

⚠️ 注意：如果你从 Railway 复制到的是这种模板（包含 `\${{RAILWAY_TCP_PROXY_PORT}}` 之类），它只会在 Railway 运行环境里被替换，
本地运行脚本会报错。请在 Railway 的 Postgres `Connect` 页面复制 **Public connection string**（带真实 host/port）。

## 3) Demo 跑通（写入 3 个产品）

会把 **Tom Ford / The Ordinary / Helena Rubinstein** 写入 `products`/`sku_vectors`/`ingredients`。

```bash
cd client
python3 worker/ingest.py --demo --overwrite
```

默认 LLM 模型是 `gemini-2.5-flash`（可用 `--llm-model` 覆盖）。
默认 embedding 模型是 `gemini-embedding-001`（可用 `--embedding-model` 覆盖）。

默认会优先用 OpenAI 做 Social 模拟（如果检测到 `OPENAI_API_KEY`）；否则退回用 Gemini 在同一个 JSON 里生成占位 social_stats。
你也可以显式指定：

```bash
# 强制用 OpenAI 做 Social（推荐）
python3 worker/ingest.py --demo --overwrite --social-provider openai --social-model gpt-4o

# 只用 Gemini 生成 social_stats（不调用 OpenAI）
python3 worker/ingest.py --demo --overwrite --social-provider llm
```

如果你遇到 `model not found`，先列出你这个 key 可用的模型：

```bash
cd client
python3 worker/ingest.py --list-models
```

然后把 `--llm-model` 改成列表里带 `generateContent` 的那个。

## 3.1) 不会写 SQL 的验证方式

```bash
cd client
python3 worker/verify_db.py
```

## 4) 从 Excel/CSV 批量导入

Excel 表需要至少包含这些列（列名可通过参数指定）：

- brand
- name
- ingredients
- price_usd（或 price + --price-cny-rate 自动换算）

示例：

```bash
cd client
python3 worker/ingest.py \
  --input /path/to/skus.xlsx \
  --sheet Sheet1 \
  --col-brand 品牌 \
  --col-name 商品名 \
  --col-ingredients 成分 \
  --col-price-usd 价格USD \
  --overwrite
```

## 4.1) 从 JSON 批量导入（Top 10 快速喂数）

仓库内置了一份「Top 10+ Skincare」示例数据：`worker/datasets/top10.json`（可在此基础上继续加 SKU）。

```bash
cd client
python3 worker/ingest.py --input-json worker/datasets/top10.json --overwrite
```

你也可以把自己准备的 JSON 列表保存成文件后用 `--input-json` 导入（支持格式：`[{...}, ...]` 或 `{ "items": [...] }`）。

## 4.2) 导入 KB Snippets（专家注脚/对比/敏感提示）

如果你的 Excel 里除了成分列，还包含 “Comparison notes / Sensitivity flags / Key actives / 用法/搭配/质地”等列，
可以把这些非结构化字段作为 **KB snippets** 写入 `product_kb_snippets`，供线上 Chat/Routine 做证据引用（RAG footnotes）。

两种方式：

1) **随产品一起导入**（会跑 LLM 向量化）：

```bash
cd client
python3 worker/ingest.py --input /path/to/skus.xlsx --sheet Sheet1 --ingest-kb --overwrite
```

2) **只导入 KB（不跑 LLM）**（推荐用于“修列名/修规则后重新 upsert KB”）：

```bash
cd client
python3 worker/ingest.py --kb-only --input /path/to/skus.xlsx
```

## 5) 注意

- LLM 输出的功效分数是 **0-100**，目前 Aurora 前端引擎使用的是 **0-1**；后续做 DB→API 映射时会做归一化。
- `embedding` 列是 `vector(1536)`：如果 Gemini embedding 返回 3072 维，脚本会 **截断到 1536** 以便写入数据库（MVP 权衡）。
- Worker 也会写入 `social_stats`（由 LLM 生成/估计的占位数据），让线上 `SocialScore` 不再是 0。

## 6) PRICE_ORACLE（离线价格补全）

Aurora 的 Excel/知识库数据通常 **没有价格列**，会导致 DB 里出现 `price_usd=0`（价格未知）。
为了避免 UI/Chat 出现 `$0` 或预算计算失真，我们引入了 **价格快照表** `product_price_snapshots`：

- 在线（Next.js）**只读**：优先读快照；没有快照时才回退到 `products.price_usd/price_cny`。
- 离线（脚本）写入快照：定期跑一次同步即可。

### 6.1 需要的环境变量

- `DATABASE_URL`：Aurora Railway Postgres
- `PIVOTA_SHOP_GATEWAY_BASE_URL`：Pivota Shop Gateway（默认：`https://web-production-fedb.up.railway.app`）
- `PIVOTA_SHOP_GATEWAY_API_KEY`：调用 Shop Gateway 的 `X-API-Key`

### 6.2 同步价格快照

```bash
cd client
python3 worker/price_oracle.py --only-missing-price
```

可选：把同步到的价格回填到 `products.price_usd/price_cny`（只在原来为 0 的情况下写入）：

```bash
cd client
python3 worker/price_oracle.py --only-missing-price --backfill-products
```

> 生产建议：用 Cron（GitHub Actions / Railway 定时任务）每天或每周跑一次即可。
