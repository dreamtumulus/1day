# 探针与告警

- `func.py`（主服务器 `/root/monitor/`，不在仓库）每 10 分钟跑一轮真实请求矩阵，结果追加到 `func.jsonl`。
  部署时把 `func-alert-hook.py` 追加到它末尾、`alert.py` 放到同目录，连续 2 轮失败即告警，恢复时通知一次。
- `extprobe.py` 跑在 worker-01（`/root/monitor/`），每 2 分钟从外部打 `https://api.1dayapi.com/health` 和 `/v1/models`，
  单元文件 `1dayapi-extprobe.{service,timer}`。主服务器整机挂掉时只有它能发现。
- 通道配置 `alert.conf`（见 `alert.conf.example`）：Telegram 或通用 webhook。`python3 alert.py test` 发一条测试消息。
- 状态文件 `alert-state-<source>.json`；阈值 `ALERT_THRESHOLD`（默认 2）。
- `proxy-down-alert.py`（主服务器 `/root/monitor/`，单元 `1dayapi-proxy-down-alert.{service,timer}`，每 10 分钟）：只读主库，
  列出 `status='proxy_down'`（代理失联被冻结，铁律 2026-11-01）的账号；新增即告警，之后**每小时重复提醒**（`REMIND_MINUTES`）直到清零，清零时通知一次。
  安装：`cp proxy-down-alert.py /root/monitor/ && cp 1dayapi-proxy-down-alert.* /etc/systemd/system/ && systemctl enable --now 1dayapi-proxy-down-alert.timer`。
