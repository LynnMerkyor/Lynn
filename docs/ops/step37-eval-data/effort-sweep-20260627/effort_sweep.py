#!/usr/bin/env python3
"""Reproduce: does step-3.7-flash 'medium'/'auto' effort think HEAVIER than 'high'?
Sweep reasoning_effort in {low,medium,high,auto} over the SAME GPQA questions.
Measure per effort: avg completion_tokens (thinking weight), avg latency, accuracy."""
import json, urllib.request, time, csv, re, random
import concurrent.futures as cf

def env(k):
    for l in open('/home/merkyor/orch_test/brain.env'):
        if l.startswith(k+'='): return l.split('=',1)[1].strip()
    return ''
URL=env('STEP_BASE').rstrip('/')+'/chat/completions'; KEY=env('STEP_KEY'); MODEL=env('STEP_TEXT_MODEL') or 'step-3.7-flash'

# Load N GPQA questions (real diamond set)
N=12
rows=[]
with open('/home/merkyor/eval-harness/gpqa_diamond.csv') as f:
    rd=csv.DictReader(f)
    for r in rd: rows.append(r)
# find the canonical revised columns
qcol='Question'
ccol='Correct Answer'
icols=['Incorrect Answer 1','Incorrect Answer 2','Incorrect Answer 3']
items=[]
for i,r in enumerate(rows[:N]):
    opts=[r[ccol], r[icols[0]], r[icols[1]], r[icols[2]]]
    rnd=random.Random(i); order=[0,1,2,3]; rnd.shuffle(order)
    letters='ABCD'; shown=[opts[o] for o in order]
    correct_letter=letters[order.index(0)]
    body=r[qcol].strip()+'\n\n'+'\n'.join(f'{letters[j]}) {shown[j]}' for j in range(4))
    body+='\n\n最后单独一行输出: 答案: <字母>'
    items.append({'q':body,'correct':correct_letter})

def call(effort, prompt):
    pl={'model':MODEL,'messages':[{'role':'user','content':prompt}],'max_tokens':32768,'temperature':0.6,'top_p':0.95}
    if effort is not None: pl['reasoning_effort']=effort
    t0=time.time()
    for _ in range(3):
        try:
            req=urllib.request.Request(URL,json.dumps(pl,ensure_ascii=False).encode(),{'Content-Type':'application/json','Authorization':'Bearer '+KEY})
            r=json.load(urllib.request.urlopen(req,timeout=300)); dt=time.time()-t0
            u=r.get('usage',{}); ct=u.get('completion_tokens',0)
            m=r['choices'][0]['message']; content=(m.get('content') or ''); rc=(m.get('reasoning_content') or '')
            return {'dt':dt,'completion_tok':ct,'think_chars':len(rc) or len(re.findall(r'<think>(.*?)</think>',content,re.S)[0]) if '<think>' in content else len(rc),
                    'content':content,'rc_len':len(rc)}
        except Exception as e:
            last=str(e)[:100]; time.sleep(4)
    return {'dt':time.time()-t0,'completion_tok':0,'think_chars':0,'content':'','err':last}

def extract(content):
    m=re.findall(r'答案[:：]\s*([ABCD])', content)
    if m: return m[-1]
    m=re.findall(r'\b([ABCD])\b', content[-80:])
    return m[-1] if m else '?'

EFFORTS=['low','medium','high','auto']
results={e:[] for e in EFFORTS}
def one(effort,idx):
    it=items[idx]; r=call(effort,it['q'])
    ans=extract(r['content']); r['correct']=(ans==it['correct']); r['ans']=ans; r['idx']=idx
    return effort,r

tasks=[(e,i) for e in EFFORTS for i in range(N)]
print(f'=== step-3.7-flash effort sweep: {len(EFFORTS)} efforts x {N} GPQA = {len(tasks)} calls ===',flush=True)
with cf.ThreadPoolExecutor(max_workers=4) as ex:
    futs=[ex.submit(one,e,i) for e,i in tasks]
    for fut in cf.as_completed(futs):
        e,r=fut.result(); results[e].append(r)
        print(f'  [{e:<6} q{r["idx"]:2}] tok={r["completion_tok"]:5} dt={r["dt"]:5.1f}s ans={r["ans"]} {"✓" if r["correct"] else "✗"}',flush=True)

print('\n==== 汇总 (思考重量 = completion_tokens) ====',flush=True)
print(f'{"effort":<8}{"avg_tok":>9}{"median_tok":>11}{"avg_lat":>9}{"acc":>8}',flush=True)
import statistics as st
summ={}
for e in EFFORTS:
    rs=results[e]; toks=[r['completion_tok'] for r in rs]; lats=[r['dt'] for r in rs]; acc=sum(r['correct'] for r in rs)/len(rs)
    summ[e]={'avg_tok':round(st.mean(toks)),'median_tok':round(st.median(toks)),'avg_lat':round(st.mean(lats),1),'acc':round(acc,3),'n':len(rs)}
    print(f'{e:<8}{summ[e]["avg_tok"]:>9}{summ[e]["median_tok"]:>11}{summ[e]["avg_lat"]:>8.1f}s{acc:>8.1%}',flush=True)
out={'model':MODEL,'n_questions':N,'summary':summ,'raw':{e:[{k:v for k,v in r.items() if k!='content'} for r in results[e]] for e in EFFORTS}}
json.dump(out,open('/home/merkyor/orch_test/effort_sweep_result.json','w'),ensure_ascii=False,indent=2)
hi=summ['high']['avg_tok']
for e in ['medium','auto','low']:
    d=summ[e]['avg_tok']-hi
    print(f'{e} vs high 思考量差: {d:+d} tok ({"更重⚠" if d>0 else "更轻"})',flush=True)
print('SAVED effort_sweep_result.json',flush=True)
