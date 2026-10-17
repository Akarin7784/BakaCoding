# @bakacoding/model-gateway

模块 1 模型接入层（T-004）：Anthropic / OpenAI 兼容协议适配、令牌桶限流与 429 退避、思考档位映射与服务商能力表、按调用计费、调用前查预算、每次调用发 `call_completed`。接口以 [docs/modules.md](../../docs/modules.md) 第 1 节为准。

```ts
const gw = createModelGateway({
  getConfig: () => config, // 模块 3 的 Config
  pricing, // loadPricing("config/pricing.json")
  budget, // 模块 3 createBudget() 的返回值
  publish: (e) => bus.publish(e),
});
const r = await gw.chat({ role: "coder", provider, model, effort, system, tools, messages, ctx, signal });
```

## 要点

- **协议**：DeepSeek 默认走 Anthropic 兼容接口（`<base_url>/v1/messages`，`x-api-key`，`anthropic-version: 2023-06-01`），请求序列化参照 DeepSeek Harness dsh-v0.2.1-alpha.5 的 `serialize.ts`：档位写 `thinking` + `output_config.effort`，`off` 时 thinking disabled；工具结果排在同一条 user 消息最前，历史中的 system 消息放在前一个 user / 工具结果之后。OpenAI 兼容（`<base_url>/chat/completions`，Bearer）为备选，档位写 `reasoning_effort`。v1 用非流式请求。
- **能力表与降档**：`capabilities(provider)`。不支持的档位降到不高于它的最高可用档，经 `onWarning` 报一条警告，不报错；模型 `thinking_enabled: false` 时只能 `off`。
- **密钥**：按配置的 `credential_ref`（`env:DEEPSEEK_API_KEY`）经模块 3 的 `getSecret` 读，不落日志、不进错误信息。
- **预算**：调用前按「请求体字符数 × 未命中价 + 输出上限 × 输出价」向模块 3 `reserve` 预占，不够抛 `BudgetExceededError`（`code: "BUDGET_EXCEEDED"`），不发请求；`call_completed` 记进台账后释放。模型不在 `pricing.json` 里直接报 `CONFIG`。
- **max_tokens / 超时**：模型配置填了 `max_tokens` 才传；服务商配置 `request_timeout_ms` 默认 10 分钟。
- **限流与重试**：令牌桶按服务商（账号）全局共享。429、500/502/503/504、连接错误和超时合计最多重试 3 次，指数退避加抖动，429 与 `retry-after` 取较大值，每次重试前检查 `signal`；退避状态按 provider/model 记。参数是 `createModelGateway({ rateLimit })` 的选项。
- **工具调用串行**：DeepSeek 忽略 `disable_parallel_tool_use`，需要串行时由调用方逐个执行。
- **思考内容**：`chat` 返回 `reasoning`，assistant 消息带 `reasoning` 回传；OpenAI 协议下写成 `reasoning_content`（DeepSeek 带 tools 时必须回传，见 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)）。它属于模型内容，只记进 `call_completed.prompt`（桌面会遮蔽），不进 `output`。
- **事件**：请求真的发出去了才发 `call_completed`；成功 `error: null`，失败 `error: { code }`（取消为 `ABORTED`）。失败时已解析出用量的按实际 token 计费，否则记 0。
- **token**：`input` 含缓存命中，`cache_hit_input` 为缓存读取，未命中 = 两者之差，费用按两档价格算。
