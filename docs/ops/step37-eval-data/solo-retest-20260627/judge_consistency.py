#!/usr/bin/env python3
"""Test the user's hypothesis: is DS V4 Pro the unstable/inaccurate component?
Re-judge the SAME keep-run trajectories N times with ds-pro (temp 0, exact harness judge()).
Measures: (a) self-consistency (do verdicts flip on identical input?), (b) accuracy vs Claude ground truth."""
import json, urllib.request, time

def env(k):
    for l in open('/home/merkyor/orch_test/brain.env'):
        if l.startswith(k+'='): return l.split('=',1)[1].strip()
    return ''
DS_URL = env('DEEPSEEK_BASE').rstrip('/')+'/chat/completions'
DS_KEY = env('DEEPSEEK_KEY')
DS_MODEL = env('DEEPSEEK_PRO_MODEL') or 'deepseek-v4-pro'
JUDGE_SYS = ('你是独立评审,看任务与真实执行轨迹。严格输出 JSON:'
             '{"success":true|false,"decomp":1-5,"reason":"一句话"}。success=任务是否真完成;decomp=拆解合理度。')

def judge_once(prompt, turns):
    lines = [("[最终] "+t["final"]) if "final" in t else f"[{t['tool']}:{t['arg'][:80]}]->{t['obs'][:150]}" for t in turns]
    msgs=[{"role":"system","content":JUDGE_SYS},{"role":"user","content":f"任务:{prompt}\n轨迹:\n"+"\n".join(lines)}]
    payload=json.dumps({"model":DS_MODEL,"messages":msgs,"max_tokens":600,"temperature":0},ensure_ascii=False).encode()
    for _ in range(4):
        try:
            req=urllib.request.Request(DS_URL,payload,{"Content-Type":"application/json","Authorization":"Bearer "+DS_KEY})
            r=json.load(urllib.request.urlopen(req,timeout=120))
            m=r["choices"][0]["message"]; c=(m.get("content") or m.get("reasoning_content") or "")
            j=json.loads(c[c.find("{"):c.rfind("}")+1]); return bool(j.get("success"))
        except Exception:
            time.sleep(3)
    return None

prompts=[json.loads(l)["prompt"] for l in open('/home/merkyor/orch_test/orch_eval_3way.jsonl') if l.strip()]
d=json.load(open('/home/merkyor/orch_test/step37_solo_retest_KEEP_20260627.json'))
rows={r['i']:r for r in d['rows']}
GROUND={i:True for i in range(20)}; GROUND[3]=False  # Claude ground truth

N=5
out={"model":DS_MODEL,"N":N,"per_task":{}}
print(f"=== DS V4 Pro 判官自一致性测试: 同一批轨迹判 {N} 次 (temp 0) ===",flush=True)
for i in range(20):
    verds=[judge_once(prompts[i], rows[i]['turns']) for _ in range(N)]
    nT=sum(1 for v in verds if v is True); nF=sum(1 for v in verds if v is False)
    flip = not (nT==N or nF==N)
    out["per_task"][i]={"verdicts":verds,"flip":flip,"ground":GROUND[i]}
    print(f"[{i:2}] {str(verds):<40} {'⚠FLIP' if flip else 'stable':<7} truth={'✓' if GROUND[i] else '✗'}",flush=True)

# aggregate
per_run_totals=[sum(1 for i in range(20) if out['per_task'][i]['verdicts'][n] is True) for n in range(N)]
flips=[i for i in range(20) if out['per_task'][i]['flip']]
# accuracy vs ground (majority verdict)
def maj(vs):
    t=sum(1 for v in vs if v is True); return t > len(vs)/2
ds_errors=[i for i in range(20) if maj(out['per_task'][i]['verdicts'])!=GROUND[i]]
out["summary"]={"per_run_totals":per_run_totals,"flip_tasks":flips,"ds_vs_ground_errors":ds_errors,
                "ground_total":sum(GROUND.values())}
json.dump(out,open('/home/merkyor/orch_test/ds_judge_consistency.json','w'),ensure_ascii=False,indent=2)
print(f"\n每轮总分(同一批轨迹): {per_run_totals}  → 极差 {max(per_run_totals)-min(per_run_totals)}",flush=True)
print(f"翻供题(同输入不同判): {flips}",flush=True)
print(f"DS多数判 vs Claude真值 不一致题: {ds_errors}  (真值总分 {sum(GROUND.values())}/20)",flush=True)
print("SAVED ds_judge_consistency.json",flush=True)
