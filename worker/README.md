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

需要两个：

- `DATABASE_URL`：Railway Postgres 连接串
- `GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）：Google Gemini API Key

你可以放在 `client/.env`（本项目已忽略 `.env`，不会提交到 git）：

```bash
DATABASE_URL='postgresql://...'
GEMINI_API_KEY='...'
```

## 3) Demo 跑通（写入 3 个产品）

会把 **Tom Ford / The Ordinary / Helena Rubinstein** 写入 `products`/`sku_vectors`/`ingredients`。

```bash
cd client
python3 worker/ingest.py --demo --overwrite
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

## 5) 注意

- LLM 输出的功效分数是 **0-100**，目前 Aurora 前端引擎使用的是 **0-1**；后续做 DB→API 映射时会做归一化。
- `embedding` 是 `vector(1536)`；Gemini embedding 维度如果不是 1536，会自动 **补 0** 到 1536（不影响 cosine 相似度）。
