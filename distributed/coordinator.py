#!/usr/bin/env python3
"""Kontrol ağında çalışan, bağımlılıksız merkezi stop koordinatörü."""
import argparse, json, math, threading, time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class State:
    def __init__(self, args):
        self.args, self.started = args, time.time()
        self.lock, self.stop, self.windows = threading.Lock(), None, deque()
        self.regions = defaultdict(lambda: {"requests": 0, "failures": 0, "timeouts": 0, "durations": [], "statuses": defaultdict(int)})

    def ingest(self, sample):
        now = time.time()
        with self.lock:
            if self.stop: return
            self.windows.append((now, sample))
            bucket = self.regions[sample.get("region", "unknown")]
            for key in ("requests", "failures", "timeouts"): bucket[key] += int(sample.get(key, 0))
            bucket["durations"].extend(sample.get("durations", []))
            for code, count in sample.get("statuses", {}).items(): bucket["statuses"][str(code)] += int(count)
            cutoff = now - self.args.window
            while self.windows and self.windows[0][0] < cutoff: self.windows.popleft()
            if now - self.started < self.args.warmup: return
            requests = sum(s.get("requests", 0) for _, s in self.windows)
            failures = sum(s.get("failures", 0) for _, s in self.windows)
            durations = sorted(d for _, s in self.windows for d in s.get("durations", []))
            if requests < self.args.min_samples: return
            groups = [("global", requests, failures, durations)]
            for region in {s.get("region", "unknown") for _, s in self.windows}:
                region_samples = [s for _, s in self.windows if s.get("region", "unknown") == region]
                groups.append((f"region {region}", sum(s.get("requests", 0) for s in region_samples),
                               sum(s.get("failures", 0) for s in region_samples),
                               sorted(d for s in region_samples for d in s.get("durations", []))))
            for label, group_requests, group_failures, group_durations in groups:
                if group_requests < self.args.min_samples: continue
                error_rate = group_failures / group_requests
                p95 = group_durations[max(0, math.ceil(len(group_durations) * .95) - 1)] if group_durations else 0
                if error_rate >= self.args.error_rate:
                    self.stop = f"{label} error rate {error_rate:.4f} >= {self.args.error_rate}"; break
                if p95 >= self.args.p95_ms:
                    self.stop = f"{label} p95 {p95:.1f}ms >= {self.args.p95_ms}ms"; break

    def report(self):
        with self.lock:
            def summarize(bucket):
                durations = sorted(bucket["durations"])
                pct = lambda p: durations[max(0, math.ceil(len(durations)*p)-1)] if durations else 0
                elapsed = max(time.time() - self.started, .001)
                return {"requests": bucket["requests"], "rps": bucket["requests"] / elapsed, "failures": bucket["failures"],
                        "error_rate": bucket["failures"] / bucket["requests"] if bucket["requests"] else 0,
                        "timeouts": bucket["timeouts"], "p50_ms": pct(.5), "p95_ms": pct(.95), "p99_ms": pct(.99),
                        "statuses": dict(bucket["statuses"])}
            regions = {region: summarize(bucket) for region, bucket in self.regions.items()}
            total = {"requests": 0, "failures": 0, "timeouts": 0, "durations": [], "statuses": defaultdict(int)}
            for bucket in self.regions.values():
                for key in ("requests", "failures", "timeouts"): total[key] += bucket[key]
                total["durations"].extend(bucket["durations"])
                for code, count in bucket["statuses"].items(): total["statuses"][code] += count
            return {"stopped": bool(self.stop), "reason": self.stop, "elapsed_seconds": round(time.time()-self.started, 1),
                    "regions": regions, "total": summarize(total)}

class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        body = json.dumps(value).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.send_json(200, STATE.report()) if self.path == "/state" else self.send_json(404, {"error": "not found"})
    def do_POST(self):
        if self.path != "/sample": return self.send_json(404, {"error": "not found"})
        try:
            sample = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            STATE.ingest(sample); self.send_json(200, STATE.report())
        except Exception as exc: self.send_json(400, {"error": str(exc)})
    def log_message(self, fmt, *args): pass

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="127.0.0.1"); parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--warmup", type=int, default=15); parser.add_argument("--window", type=int, default=10)
    parser.add_argument("--error-rate", type=float, default=.02); parser.add_argument("--p95-ms", type=int, default=1500)
    parser.add_argument("--min-samples", type=int, default=20)
    args = parser.parse_args(); STATE = State(args)
    print(f"Coordinator http://{args.listen}:{args.port} (yalnızca güvenilir kontrol ağına açın)", flush=True)
    try: ThreadingHTTPServer((args.listen, args.port), Handler).serve_forever()
    except KeyboardInterrupt: pass
    finally:
        with open("distributed-summary.json", "w") as output: json.dump(STATE.report(), output, indent=2)
