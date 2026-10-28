# 探针与告警

- `func.py`（主服务器 `/root/monitor/`，不在仓库）每 10 分钟跑一轮真实请求矩阵，结果追加到 `func.jsonl`。
  部署时把 `func-alert-hook.py` 追加到它末尾、`alert.py` 放到同目录，连续 2 轮失败即告警，恢复时通知一次。
- `extprobe.py` 跑在 worker-01（`/root/monitor/`），每 2 分钟从外部打 `https://api.1dayapi.com/health` 和 `/v1/models`，
  单元文件 `1dayapi-extprobe.{service,timer}`。主服务器整机挂掉时只有它能发现。
- 通道配置 `alert.conf`（见 `alert.conf.example`）：Telegram 或通用 webhook。`python3 alert.py test` 发一条测试消息。
- 状态文件 `alert-state-<source>.json`；阈值 `ALERT_THRESHOLD`（默认 2）。
