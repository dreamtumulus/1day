#!/usr/bin/env python3
"""Alert delivery for the 1dayAPI probes (func.py on the main server, extprobe.py on worker-01).

Channels are read from alert.conf next to this file (KEY=VALUE lines, mode 0600):
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   -> Telegram sendMessage
  WEBHOOK_URL                             -> POST JSON {"text": ..., "ok": bool, "source": ...}
State lives in alert-state.json next to this file: consecutive failures and whether an alert is
open, so one blip stays quiet (threshold 2) and a recovery is announced exactly once.
Never prints or sends secrets. Uses the direct network (no proxy env)."""
import json, os, sys, time, urllib.request

D = os.path.dirname(os.path.abspath(__file__))
THRESHOLD = int(os.environ.get("ALERT_THRESHOLD", "2"))


def _conf():
    out = {}
    try:
        for line in open(os.path.join(D, "alert.conf")):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return out


def _state_path(source):
    return os.path.join(D, f"alert-state-{source}.json")


def _load(source):
    try:
        return json.load(open(_state_path(source)))
    except Exception:
        return {"failures": 0, "open": False, "since": None}


def _save(source, st):
    tmp = _state_path(source) + ".tmp"
    json.dump(st, open(tmp, "w"))
    os.replace(tmp, _state_path(source))


def send(text, ok, source):
    """Deliver one message to every configured channel; returns the list of channels that accepted it."""
    conf = _conf()
    delivered = []
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        os.environ.pop(k, None)
    if conf.get("TELEGRAM_BOT_TOKEN") and conf.get("TELEGRAM_CHAT_ID"):
        try:
            body = json.dumps({"chat_id": conf["TELEGRAM_CHAT_ID"], "text": text, "disable_web_page_preview": True}).encode()
            req = urllib.request.Request(f"https://api.telegram.org/bot{conf['TELEGRAM_BOT_TOKEN']}/sendMessage", data=body,
                                         headers={"content-type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.status == 200:
                    delivered.append("telegram")
        except Exception as e:
            print(f"alert: telegram failed: {type(e).__name__}", file=sys.stderr)
    if conf.get("WEBHOOK_URL"):
        try:
            body = json.dumps({"text": text, "ok": ok, "source": source, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}).encode()
            req = urllib.request.Request(conf["WEBHOOK_URL"], data=body, headers={"content-type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=15) as r:
                if 200 <= r.status < 300:
                    delivered.append("webhook")
        except Exception as e:
            print(f"alert: webhook failed: {type(e).__name__}", file=sys.stderr)
    if not delivered:
        print(f"alert: no channel delivered ({'no channel configured' if not conf else 'all channels failed'}): {text[:200]}", file=sys.stderr)
    return delivered


def evaluate(failed, source, detail=""):
    """failed: list of failing check names (empty = all good). Alerts after THRESHOLD consecutive
    failing runs, announces recovery once. Returns the state after this run."""
    st = _load(source)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if failed:
        st["failures"] = st.get("failures", 0) + 1
        st.setdefault("since", now)
        if st["failures"] >= THRESHOLD and not st.get("open"):
            text = f"[1dayAPI][{source}] 平台探测连续 {st['failures']} 次失败（自 {st['since']}）：{', '.join(failed)}\n{detail}".strip()
            if send(text, False, source):
                st["open"] = True
    else:
        if st.get("open"):
            text = f"[1dayAPI][{source}] 已恢复（{now}），此前自 {st.get('since')} 起失败"
            send(text, True, source)
        st = {"failures": 0, "open": False, "since": None}
    _save(source, st)
    return st


if __name__ == "__main__":
    # `alert.py test` sends a test message to every configured channel.
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        print(send("[1dayAPI] 告警通道测试", True, "manual"))
