#!/usr/bin/env python3
"""k6 JSON akışını özetler, koordinatöre yollar ve global stop'ta k6'yı sonlandırır."""
import argparse, json, os, signal, subprocess, threading, time, urllib.request
from collections import defaultdict

def api(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3) as response: return json.load(response)

parser = argparse.ArgumentParser()
parser.add_argument("--coordinator", required=True); parser.add_argument("--json", required=True); parser.add_argument("--console", required=True)
args = parser.parse_args(); region = os.environ.get("REGION_TAG", "local"); stopped = threading.Event()
process = subprocess.Popen(["k6", "run", "--out", f"json={args.json}", "k6_test.js"], start_new_session=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

def copy_output():
    with open(args.console, "w") as log:
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line); log.flush()

output_thread = threading.Thread(target=copy_output, daemon=True); output_thread.start()

def terminate():
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGINT)
        try: process.wait(timeout=8)
        except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGTERM)

def monitor():
    position = 0
    while process.poll() is None and not stopped.is_set():
        sample = {"region": region, "requests": 0, "failures": 0, "timeouts": 0, "durations": [], "statuses": defaultdict(int)}
        try:
            with open(args.json) as output:
                output.seek(position)
                for line in output:
                    try: item = json.loads(line)
                    except json.JSONDecodeError: continue
                    if item.get("type") != "Point": continue
                    metric, data = item.get("metric"), item.get("data", {})
                    value, tags = data.get("value", 0), data.get("tags", {})
                    if metric == "http_reqs": sample["requests"] += int(value)
                    elif metric == "failed_requests" and value: sample["failures"] += 1
                    elif metric == "timeouts": sample["timeouts"] += int(value)
                    elif metric == "response_duration": sample["durations"].append(float(value))
                    elif metric == "status_codes": sample["statuses"][str(tags.get("status", "0"))] += int(value)
                position = output.tell()
            state = api(args.coordinator.rstrip("/") + "/sample", "POST", {**sample, "statuses": dict(sample["statuses"])})
            if state.get("stopped"):
                print(f"Merkezi durdurma: {state.get('reason')}", flush=True); stopped.set(); terminate(); return
        except (OSError, ValueError) as exc: print(f"Koordinatör/telemetri uyarısı: {exc}", flush=True)
        time.sleep(1)

thread = threading.Thread(target=monitor, daemon=True); thread.start()
try: code = process.wait()
except KeyboardInterrupt: terminate(); code = process.wait()
stopped.set(); thread.join(timeout=2)
output_thread.join(timeout=2)
try: print(json.dumps(api(args.coordinator.rstrip("/") + "/state"), indent=2))
except OSError: pass
raise SystemExit(code)
