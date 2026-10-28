# 模型目录与定价（packages/catalog）

> `@1dayapi/catalog`：纯数据 + 计价函数，被 gateway（鉴权后列表、计费）与 console（公开 API）引用。
> **v3**：目录只是模型注册表的种子。网关与控制台通过 `@1dayapi/core` 的注册表使用它：管理员可在"模型定价"中覆盖价格、下架模型或新增自定义模型（`model_prices` 表），
> 不在注册表内的模型被网关拒绝（不再出现"未知模型 0 计费"），`status` 不为 `active` 的目录模型默认下架。见 `v3-design.md` §6。
> 数据源自对原站 `/api/models` 与 `/v1/models/pricing` 的抓取（`recon/models.json`、`recon/v1-models-pricing.json`）。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `data/models.json` | `{data: CatalogModel[]}`，45 条（站点展示格式） |
| `data/pricing.json` | `{data: PricingEntry[]}`，45 条（网关定价格式） |
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
| `input_tokens` | 41 | ✅ |
| `output_tokens` | 41 | ✅ |
| `cache_read_tokens` | 41 | ✅（Anthropic `cache_read_input_tokens`；OpenAI 的 cached_tokens 不识别） |
| `cache_write_tokens` | 20 | ✅（Anthropic `cache_creation_input_tokens`） |
| `cache_write_5m_tokens` | 20 | ❌ 网关从不产生 |
| `cache_write_1h_tokens` | 13 | ❌ 网关从不产生 |
| `output_images` | 5 | ❌ 图片端点 501 |
| `output_video` | 16 | ❌ 视频端点是桩且不计费 |

## 4. 厂商与模型（45 个；41 个 `active`、4 个 `unavailable`）

| vendor | 数量 | 模型 | 网关可用性 |
|---|---|---|---|
| anthropic | 13 | claude-fable-5, claude-fable-5-1, claude-haiku-4-5, claude-haiku-5-5, claude-opus-4-6/4-7/4-8, claude-opus-5, claude-opus-5-5, claude-sonnet-4-5/4-6, claude-sonnet-5, claude-sonnet-5-5 | ✅ |
| openai | 8 | gpt-5.5, gpt-5.6-luna/sol/terra, gpt-6-astra/luna/sol, gpt-6.1-sol | ✅ |
| moonshot | 2 | kimi-for-coding, kimi-k3 | 🟡 仅隧道 |
| opencode | 6 | deepseek-flash, hy4-preview, longcat-2.0, mimo-v2.6-flash/pro, muse-spark-1.3-contributor | ❌ |
| volcengine | 5 | deepseek-v4-flash/pro, doubao-seed-2.0-mini, doubao-seed-2.1-lite/pro | ❌ |
| xai | 4 | grok-4.3/4.5/4.6/4.7 | ❌ |
| zhipu | 2 | glm-5.3, glm-5.3-flash | ❌ |
| qwen | 2 | qwen3.7-plus, qwen3.8-max | ❌ |
| minimax | 1 | MiniMax-M3 | ❌ |
| google | 1 | gemini-3.5-flash | ❌ |
| xiaomi | 1 | mimo-v2.5-pro | ❌ |

"❌" 表示网关会把请求发到 OpenAI 上游（见 `gateway.md §5`）。输出模态：text 41、image 2、video 2。

## 5. API

| 函数 | 返回 |
|---|---|
| `listModels()` | `CatalogModel[]` |
| `listPricing()` | `PricingEntry[]` |
| `getModel(id)` | 按 `modelId` 查找 |
| `getPricing(id)` | 按 `id` 查找 |
| `estimateCost(modelId, usage)` | USD：Σ `usage[sku.meter] / sku.quantity × Number(sku.price_usd)`；未知模型返回 0；用量缺失或 ≤0 的 meter 跳过 |

`TokenUsage = {input_tokens, output_tokens, cache_read_tokens?, cache_write_tokens?, cache_write_5m_tokens?, cache_write_1h_tokens?}`。

## 6. 维护注意

- `models.json` 与 `pricing.json` 的 id 必须一一对应，没有校验脚本。
- v3：目录 `status` 不为 `active` 的模型在注册表中默认下架（可在控制台覆盖）；`available` 字段不参与判断。`/api/model-availability` 已删除。
- 价格是原站某一时刻的快照（`pricing_mode: dynamic_discount` 原意是动态折扣），本项目里是静态的。
