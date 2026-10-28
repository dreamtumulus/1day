# Appended to /root/monitor/func.py at deploy time (ops/monitor/install.sh): after `results` is
# complete, hand the failing check names to alert.evaluate(). Kept separate so func.py's probe
# logic stays as deployed on 2026-10-19.
try:
    import alert as _alert
    _failed = [k for k, v in results.items() if k != "admin_view" and v.get("ok") is False]
    _detail = "; ".join(f"{k}: HTTP {results[k].get('status')} {str(results[k].get('err') or '')[:80]}" for k in _failed)[:600]
    _alert.evaluate(_failed, "monitor", _detail)
except Exception as _e:
    print("alert hook error", type(_e).__name__, _e)
