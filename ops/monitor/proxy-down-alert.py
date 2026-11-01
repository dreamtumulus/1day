#!/usr/bin/env python3
"""Reminder for frozen accounts (operator rule 2026-11-01, docs/onboarding.md §1.2).

Reads the main database read-only, lists accounts in status proxy_down and sends an alert through alert.py:
immediately when the set of frozen accounts grows, then a repeat reminder every REMIND_MINUTES (default 60)
while any account stays frozen, and one recovery message when the list is empty again. Runs from the
1dayapi-proxy-down-alert.timer (every 10 min) on the main server; needs the same alert.conf as alert.py.
"""
import json, os, sqlite3, sys, time

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
from alert import send  # noqa: E402

DB = os.environ.get("DB_PATH", "/opt/1dayapi/data/1dayapi.db")
STATE = os.path.join(D, "proxy-down-state.json")
REMIND = int(os.environ.get("REMIND_MINUTES", "60")) * 60


def frozen():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute(
            "SELECT id, name, node_id, proxy_down_since, proxy_down_reason, proxy_down_proxy_id FROM accounts WHERE status='proxy_down' ORDER BY proxy_down_since"
        ).fetchall()
    finally:
        con.close()
    return [{"id": r[0], "name": r[1], "node": (r[2] or "")[5:13], "since": r[3] or "", "why": (r[4] or "")[:120], "proxy": r[5] or "?"} for r in rows]


def fmt_age(since):
    try:
        mins = int((time.time() - time.mktime(time.strptime(since, "%Y-%m-%dT%H:%M:%SZ")) + time.timezone) // 60)
    except Exception:
        return "?"
    return f"{mins // 60}h{mins % 60:02d}m"


def main():
    try:
        st = json.load(open(STATE))
    except Exception:
        st = {"ids": [], "last_sent": 0}
    rows = frozen()
    ids = sorted(r["id"] for r in rows)
    now = time.time()
    if not rows:
        if st.get("ids"):
            send("[1dayAPI][proxy-down] 已清零：所有代理失联冻结的账号都已解除或改绑。", True, "proxy-down")
        json.dump({"ids": [], "last_sent": 0}, open(STATE, "w"))
        return
    grew = any(i not in st.get("ids", []) for i in ids)
    due = now - st.get("last_sent", 0) >= REMIND
    if grew or due:
        lines = [f"[1dayAPI][proxy-down] {len(rows)} 个账号因代理失联被冻结，不接任何请求，需人工「解除冻结」或「更换代理 IP」（控制台 → 账号 → 筛选 proxy_down）："]
        for r in rows[:12]:
            lines.append(f"  · {r['name']} @{r['node']} 代理 {r['proxy']} 自 {r['since']}（已 {fmt_age(r['since'])}）：{r['why']}")
        if len(rows) > 12:
            lines.append(f"  … 另 {len(rows) - 12} 个")
        lines.append("每小时重复提醒直到清零。" if not grew else "新增冻结账号。每小时重复提醒直到清零。")
        if send("\n".join(lines), False, "proxy-down"):
            st["last_sent"] = now
    st["ids"] = ids
    json.dump(st, open(STATE, "w"))


if __name__ == "__main__":
    main()
