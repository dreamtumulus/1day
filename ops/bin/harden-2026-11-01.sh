#!/bin/bash
# 2026-11-01 审计修复的服务器侧步骤（主服务器 89.117.17.224，以 root 运行）。
# 幂等；分阶段执行，每阶段单独确认：
#   bash ops/bin/harden-2026-11-01.sh perms               # 1. 主库 / 备份包权限
#   bash ops/bin/harden-2026-11-01.sh backup-retention    # 2. 备份保留份数 28/60 → 168/360（每小时节奏 = 7 天 / 15 天）
#   bash ops/bin/harden-2026-11-01.sh deprivilege-prepare # 3a. 建 1dayapi 用户、chown、写 systemd drop-in（不重启）
#   bash ops/bin/harden-2026-11-01.sh deprivilege-apply   # 3b. 维护窗口：restart console（会断在途隧道）+ gateway-switch（零中断）
# 说明见 docs/deployment/2026-11-01-tool-round-capacity-and-hardening.md
set -euo pipefail
ROOT=/opt/1dayapi
BK=/usr/local/bin/1dayapi-backup.sh
case "${1:-}" in
  perms)
    chmod 600 /opt/1dayapi/data/1dayapi.db /opt/1dayapi/data/1dayapi.db-wal /opt/1dayapi/data/1dayapi.db-shm 2>/dev/null || true
    chmod 700 /opt/1dayapi/backups /opt/1dayapi/backups/auto 2>/dev/null || true
    find /opt/1dayapi/backups -maxdepth 2 -type f \( -name '*.tgz' -o -name '*.tar.gz' \) -exec chmod 600 {} +
    # 新备份包落盘后立即 0600（脚本原来只对解包目录 go-rwx，tar.gz 本身是 644）：在 tar 行后面追加一行 chmod
    if ! grep -q '^chmod 600 "$ROOT/$TS.tar.gz"' "$BK"; then
      cp "$BK" "$BK.bak-$(date -u +%Y%m%dT%H%M%SZ)"
      sed -i '/^tar -C "\$ROOT" -czf "\$ROOT\/\$TS.tar.gz"/a chmod 600 "$ROOT/$TS.tar.gz"' "$BK"
      bash -n "$BK"
    fi
    ls -l /opt/1dayapi/data/1dayapi.db; ls -ld /opt/1dayapi/backups /opt/1dayapi/backups/auto
    grep -n 'chmod 600 "$ROOT/$TS.tar.gz"' "$BK"
    ;;
  backup-retention)
    cp "$BK" "$BK.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    sed -i 's#tail -n +29 | xargs -r rm -f#tail -n +169 | xargs -r rm -f#' "$BK"
    sed -i 's#tail -n +61 | xargs -r rm -f#tail -n +361 | xargs -r rm -f#' "$BK"
    bash -n "$BK"; grep -nE 'tail -n \+(169|361)' "$BK"
    echo "本地约 168 × 220 MB ≈ 37 GB（可用 359 GB）；worker-01 约 360 × 220 MB ≈ 80 GB（可用 671 GB）"
    ;;
  deprivilege-prepare)
    id -u 1dayapi >/dev/null 2>&1 || useradd --system --home-dir /var/lib/1dayapi --create-home --shell /usr/sbin/nologin 1dayapi
    # console 打包节点 bundle 需要 bun（BUN_PATH → PATH → ~/.bun）；/root 对服务用户不可读，复制一份
    [ -x /usr/local/bin/bun ] || install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
    # backups/ 由 root 的备份 timer 维护，保持 root；其余（代码、dist、data、node_modules）归服务用户
    find /opt/1dayapi -mindepth 1 -maxdepth 1 ! -name backups -exec chown -R 1dayapi:1dayapi {} +
    chown 1dayapi:1dayapi /opt/1dayapi
    # directories under data/ (settlement-journal, bundle-cache …) need the execute bit: 700 for dirs, 600 for files.
    # (2026-11-01 first run used `chmod 600 data/*`, which hit the directories too → gateway EACCES on the settlement journal for ~1 min.)
    find /opt/1dayapi/data -type d -exec chmod 700 {} +; find /opt/1dayapi/data -type f -exec chmod 600 {} +
    for u in 1dayapi-console.service 1dayapi-gateway@.service; do
      mkdir -p "/etc/systemd/system/$u.d"
      cat > "/etc/systemd/system/$u.d/10-user.conf" <<'UNIT'
[Service]
User=1dayapi
Group=1dayapi
Environment=HOME=/var/lib/1dayapi
Environment=BUN_PATH=/usr/local/bin/bun
UNIT
    done
    systemctl daemon-reload
    systemctl show 1dayapi-console -p User --value; systemctl show 1dayapi-gateway@8400 -p User --value
    echo "已准备；未重启。重启前确认：ls -ld /opt/1dayapi/data；mock-upstream 仍为 root（无需改）。"
    ;;
  deprivilege-apply)
    systemctl restart 1dayapi-console
    sleep 3; systemctl is-active 1dayapi-console; ps -o user=,pid=,cmd= -C node | grep console || true
    "$ROOT"/ops/bin/gateway-switch
    "$ROOT"/ops/bin/gateway-switch --status
    ps -o user=,pid=,cmd= -C node | grep -E 'gateway|console' || true
    curl -s https://api.1dayapi.com/health; echo
    ;;
  *) sed -n 2,8p "$0"; exit 1;;
esac
