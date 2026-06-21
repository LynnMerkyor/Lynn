#!/usr/bin/env python3
"""
5-Step Door Access Test — Chat Toolchain Verification
每个步骤模拟一扇"闸机"，通过则亮绿灯，失败则报警并记录。
"""
import subprocess, sys, json, os, time, urllib.request, socket

PASS = []
FAIL = []

def step(name, ok, detail=""):
    if ok:
        PASS.append(name)
        icon = "✅"
    else:
        FAIL.append(name)
        icon = "❌"
    print(f"  {icon} {name}" + (f"  | {detail}" if detail else ""))

def gate(name, fn):
    """Run a gate test, handle exceptions as failures."""
    print(f"\n🚪 Gate: {name}")
    print("-" * 50)
    try:
        fn()
    except Exception as e:
        step(name, False, str(e))

# -------- Gate 1: 卡片识读（网络可达性 + DNS） --------
def gate1_card():
    # 模拟门禁卡读取 = 检测基础网络通不通
    host = "api.github.com"
    ip = socket.gethostbyname(host)
    step("DNS 解析", True, f"{host} → {ip}")

    req = urllib.request.Request("https://httpbin.org/get", method="GET", headers={"User-Agent": "access-test"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        code = resp.status
        step("HTTP 外网可达", code == 200, f"HTTP {code}")

# -------- Gate 2: 指纹比对（本地文件系统 + 命令执行） --------
def gate2_biometric():
    # 模拟指纹采集 = 测试本地读写和命令执行
    path = "/tmp/access_fingerprint.txt"
    with open(path, "w") as f:
        f.write(f"biometric_scan_{int(time.time())}\n")
    step("指纹写入暂存", os.path.exists(path), f"file://{path}")

    r = subprocess.run(["cat", path], capture_output=True, text=True)
    step("指纹读取比对", r.returncode == 0 and "biometric_scan" in r.stdout, r.stdout.strip())

    os.remove(path)
    step("指纹记录清除", not os.path.exists(path))

# -------- Gate 3: 权限策略（pip 依赖一致性检查） --------
def gate3_permission():
    # 模拟权限矩阵校验 = 验证基础依赖完整性
    requirements = ["requests", "urllib3", "certifi"]
    # 用 import 检验
    missing = []
    for pkg in requirements:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        step("python 依赖完整性", False, f"缺失: {', '.join(missing)}")
    else:
        step("python 依赖完整性", True, "requests, urllib3, certifi 均在")

    # python 版本检查
    v = sys.version_info
    step("python 版本策略", v.major == 3 and v.minor >= 9, f"{v.major}.{v.minor}.{v.micro}")

# -------- Gate 4: 告警系统（错误上报链路） --------
def gate4_alarm():
    # 模拟触发告警 = 故意抓一个 404，检验异常链是否完整
    try:
        req = urllib.request.Request("https://httpbin.org/status/404", method="GET", headers={"User-Agent": "access-test"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except urllib.error.HTTPError as e:
        step("404 告警捕获", e.code == 404, f"HTTP {e.code}")
    except Exception as e:
        step("网络异常告警", False, str(e))

    # 超时场景
    try:
        req = urllib.request.Request("https://httpbin.org/delay/5", method="GET", headers={"User-Agent": "access-test"})
        with urllib.request.urlopen(req, timeout=2) as resp:
            pass
        step("超时告警触发", False, "未超时（异常）")
    except Exception as e:
        # 超时是预期行为
        step("超时告警触发", "Timeout" in str(type(e).__name__) or "timed out" in str(e).lower(), type(e).__name__)

# -------- Gate 5: 日志归档（跨工具写读） --------
def gate5_audit():
    # 模拟审计日志 = 通过 bash 写日志然后读取校验
    log_path = "/tmp/access_audit.log"
    header = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] ACCESS_TEST_RUN\n"
    subprocess.run(["sh", "-c", f"echo '{header}' > {log_path}"], capture_output=True)
    step("审计日志写入", os.path.exists(log_path))

    r = subprocess.run(["cat", log_path], capture_output=True, text=True)
    step("审计日志回读", "ACCESS_TEST_RUN" in r.stdout, r.stdout.strip()[:60])

    # 日志完整性校验（行数、时间戳）
    lines = r.stdout.strip().split("\n")
    step("日志轮转校验", len(lines) >= 1 and "202" in lines[0], f"{len(lines)} lines")

    os.remove(log_path)

# -------- 主入口 --------
if __name__ == "__main__":
    print("=" * 50)
    print("🚧  5-Step Door Access Test — Chat Toolchain Verification")
    print("=" * 50)

    gate("1️⃣  卡片识读 — 网络 & DNS", gate1_card)
    gate("2️⃣  指纹比对 — 文件 & 命令执行", gate2_biometric)
    gate("3️⃣  权限策略 — 依赖 & 版本", gate3_permission)
    gate("4️⃣  告警系统 — 错误 & 超时", gate4_alarm)
    gate("5️⃣  日志归档 — 写读 & 轮转", gate5_audit)

    # 汇总
    print("\n" + "=" * 50)
    total = len(PASS) + len(FAIL)
    print(f"📋 总计 {total} 项检测 | ✅ {len(PASS)} 通过 | ❌ {len(FAIL)} 未通过")
    if FAIL:
        print(f"   未通过: {', '.join(FAIL)}")
    print("=" * 50)
    sys.exit(0 if not FAIL else 1)
