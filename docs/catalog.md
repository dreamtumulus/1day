# 模型目录与定价（packages/catalog）

> `@1dayapi/catalog`：纯数据 + 计价函数，被 gateway（鉴权后列表、计费）与 console（公开 API）引用。
> **v3**：目录只是模型注册表的种子。网关与控制台通过 `@1dayapi/core` 的注册表使用它：管理员可在"模型定价"中覆盖价格、下架模型或新增自定义模型（`model_prices` 表），
> 不在注册表内的模型被网关拒绝（不再出现"未知模型 0 计费"），`status` 不为 `active` 的目录模型默认下架。见 `v3-design.md` §6。
> 数据源自对原站 `/api/models` 与 `/v1/models/pricing` 的抓取（`recon/models.json`、`recon/v1-models-pricing.json`）。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `data/models.json` | `{data: CatalogModel[]}`，14 条 Claude 模型（站点展示格式）；2026-10 之前的 45 条多厂商版本保留为 `models.json.bak-allvendors` |
| `data/pricing.json` | `{data: PricingEntry[]}`，14 条（网关定价格式）；旧版 `pricing.json.bak-allvendors` |
| `src/index.ts` | 类型定义 + `listModels / listPricing / getModel / getPricing / estimateCost` |

两个 JSON 通过 import attributes（`with { type: "json" }`）编进 `dist`，**改价必须重新构建并重启 gateway/console**。
部署 rsync 时 `packages/catalog/data/*.json` 不能排除。

## 2. 数据结构

```ts
interface CatalogModel {          // models.json
  modelId: string;                // 如 "claude-sonnet-5"
  displayName: string;
  vendor: string;                 // anthropic | openai | xai | moonshot | ...
  providers: string[];
  supplyVendors?: string[];
  status: string;                 // active | unavailable
  modelFamily: string;
  contextWindow: number;
  maxOutputTokens: number;
}

interface PricingEntry {          // pricing.json（JSON 里另有 object:"model"，接口未声明）
  id: string;                     // 与 modelId 对应
  name: string;
  owned_by: string;
  providers: string[];
  available: boolean;
  currency: "USD";
  pricing_mode: string;           // 如 "dynamic_discount"
  tags: string[];
  architecture: { modality: string; input_modalities: string[]; output_modalities: string[] };
  pricing_skus: PricingSku[];
}

interface PricingSku {
  sku_id: string;
  meter: string;                  // 见 §3
  unit: string;                   // "token" 等
  quantity: number;               // 1000000（每 1M）
  price_usd: string;              // 字符串！计算时 Number()
  reference_price_usd: string;    // 官方参考价
  savings_pct?: string;
}
```

## 3. 计量项（meter）分布

| meter | 条目数 | 网关是否会产生该用量 |
|---|---|---|
| `input_tokens` | 14 | ✅ |
| `output_tokens` | 14 | ✅ |
| `cache_read_tokens` | 14 | ✅（Anthropic `cache_read_input_tokens`；OpenAI 的 cached_tokens 不识别） |
| `cache_write_tokens` | 14 | 旧口径单一写入价（= 1 小时价）。只给**拆分前**的记录计价：`usage_logs` 里 `cache_write_tokens − 5m − 1h` 的余量、旧版本写下的结算日志 |
| `cache_write_5m_tokens` | 14 | ✅（Anthropic `cache_creation.ephemeral_5m_input_tokens`；上游只给总数时整笔归此档） |
| `cache_write_1h_tokens` | 14 | ✅（Anthropic `cache_creation.ephemeral_1h_input_tokens`） |

**缓存写入按 TTL 分档计费（X-51，2026-11-10，与官方 API 一致）**：5 分钟档 = 输入价 × 1.25，1 小时档 = 输入价 × 2，缓存读取单列。
`cache_write_tokens` 在用量里是**总数**（= 5m + 1h + 拆分前余量），不是第三档；`cacheWriteBuckets()` 是这三个数关系的唯一定义。
`packages/catalog/test/catalog.test.mjs` 断言每个模型两档俱全、比例为 1.25× / 2×、且单一 SKU 等于 1 小时价；确有例外的模型写进该测试的
`CACHE_WRITE_RATIO_EXCEPTIONS` 并注明原因（2026-11-10：14 个模型无例外）。缓存读取价与输入价的比例各模型不同（0.025×～0.1×），不做断言。

## 4. 厂商与模型（14 个，全部 anthropic / `active`；2026-11-01 核对 `data/`）

| vendor | 数量 | 模型 | 网关可用性 |
|---|---|---|---|
| anthropic | 14 | claude-fable-5, claude-fable-5-1, claude-fable-5-2, claude-haiku-4-5, claude-haiku-5-5, claude-opus-4-6/4-7/4-8, claude-opus-5, claude-opus-5-5, claude-sonnet-4-5/4-6, claude-sonnet-5, claude-sonnet-5-5 | ✅ |

另有 4 个不带版本号的别名由注册表提供（见 `architecture.md`）。目录里没有 OpenAI 协议模型，`/v1/responses` 当前没有可用上游（2026-11-01 审计 B1，待决定接 OpenAI 供给或下线该端点）。
2026-10 之前的 45 条多厂商目录（openai / moonshot / opencode / volcengine / xai / zhipu / qwen / minimax / google / xiaomi）保留在 `*.bak-allvendors`，不被加载。
输出模态：text 14（claude-fable-5-2 于 2026-11-10 加入：$8 / $40，cache read $0.20，cache write 5m $10 / 1h $16，来源为发布报道，官方价目表未直接核对）。

## 5. API

| 函数 | 返回 |
|---|---|
| `listModels()` | `CatalogModel[]` |
| `listPricing()` | `PricingEntry[]` |
| `getModel(id)` | 按 `modelId` 查找 |
| `getPricing(id)` | 按 `id` 查找 |
| `estimateCost(modelId, usage)` | USD：输入 / 输出 / 缓存读各按自己的 SKU（`用量 / sku.quantity × price_usd`）；缓存写 5m 档按 `cache_write_5m_tokens` SKU、1h 档按 `cache_write_1h_tokens` SKU、拆分前余量按 `cache_write_tokens` SKU（条目缺某档 SKU 时回退到单一 SKU）；未知模型返回 0 |
| `cacheWriteBuckets(usage)` | `{total, m5, h1, unsplit}`：`total = max(cache_write_tokens, 5m + 1h)`，`unsplit = total − 5m − 1h` |

`TokenUsage = {input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?（缓存写总数）, cache_write_5m_tokens?, cache_write_1h_tokens?（总数按 TTL 的拆分）}`。

## 6. 维护注意

- `models.json` 与 `pricing.json` 的 id 必须一一对应，由 `pnpm --filter @1dayapi/catalog test` 校验（含缓存写两档的比例）。
- v3：目录 `status` 不为 `active` 的模型在注册表中默认下架（可在控制台覆盖）；`available` 字段不参与判断。`/api/model-availability` 已删除。
- 价格是原站某一时刻的快照（`pricing_mode: dynamic_discount` 原意是动态折扣），本项目里是静态的。
