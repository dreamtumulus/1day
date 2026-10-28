# Claude Code 请求采样（docs/claude-code-compat.md §1 / §9 / §11）

升级 Claude Code 版本前，用官方二进制对本地采样服务发真实请求，逐字段比对头集、beta、计费头与 body 结构。

```bash
mkdir -p /root/cc-upgrade && cd /root/cc-upgrade && cp /opt/1dayapi/ops/cc-capture/* .
HOME=/root/cc-upgrade/home312 bun add -g @anthropic-ai/claude-code@2.1.312     # 二进制在 home312/.bun/install/global/node_modules/@anthropic-ai/claude-code-linux-x64/claude
bash capture-sdk.sh <binary> 312-sonnet oauth --model claude-sonnet-5-5 --max-thinking-tokens 1024 --settings '{"alwaysThinkingEnabled":true}'
python3 capture-interactive.py <binary> 312-int-sonnet claude-sonnet-5-5
```

- `capture-sdk.sh`：`-p` 模式，参数与 worker 一致（cc-worker.ts）；第三个参数 `oauth|apikey` 决定凭据环境变量（都是哑值，请求到不了上游）。
- `capture-interactive.py`：伪终端交互模式；预置 `.claude.json` 跳过首启向导，输入一句话后抓齐全部 `/v1/messages`（主请求带 system 块与工具）。
- 输出 `capture-<tag>.ndjson`；比对时注意区分主请求与辅助请求（标题生成、无 system 的小请求），计费头后缀按请求类型不同。
