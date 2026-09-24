import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';

const api=async(path:string,opts?:RequestInit)=>{
  const r=await fetch('/api/v1'+path,{headers:{'Content-Type':'application/json',...(opts?.headers||{})},...opts});
  const d=await r.json();
  if(!r.ok)throw Error(d.message||'请求失败');
  return d;
};

type Entry={actionId:string;actorIds:string[];act:number;slot:number};
type Draft={playId:string;assignments:Record<string,string>;timeline:Entry[];endings:number[]};
const ACTS=3,SLOTS=4;
const actionById=(actions:any[],id:string)=>actions.find((a:any)=>a.id===id);
const durationOf=(actions:any[],e:Entry)=>actionById(actions,e.actionId)?.duration??1;

function App(){
  const[tour,setTour]=useState<any>(null);
  const[data,setData]=useState<any>();
  const[busy,setBusy]=useState(false);
  const[msg,setMsg]=useState('');
  const[perf,setPerf]=useState<any>();
  const[draft,setDraft]=useState<Draft>({playId:'moon',assignments:{},timeline:[],endings:[0,0,0]});

  useEffect(()=>{
    api('/tours').then(()=>{
      const id=localStorage.getItem('tour');
      if(id)api('/tours/'+id).then(x=>{setTour(x.tour);setData(x)})
        .catch(()=>{localStorage.removeItem('tour');setMsg('存档读取失败，请开始新的巡演。')});
    }).catch(()=>setMsg('无法连接巡演服务，请确认 API 已启动后重试。'));
  },[]);

  const act=async(fn:()=>Promise<any>)=>{
    setBusy(true);setMsg('');
    try{
      const d=await fn();
      if(d.tour){setTour(d.tour);setData({...d,...data})}
      if(d.performance)setPerf(d.performance);
      if(d.ending)setMsg(`终局：${d.ending}（平均 ${d.average} 分）`);
    }catch(e:any){setMsg(e.message)}finally{setBusy(false)}
  };

  const create=()=>act(async()=>{
    const created=await api('/tours',{method:'POST',body:JSON.stringify({name:'纸月剧团'})});
    localStorage.setItem('tour',created.tour.id);
    const d=await api('/tours/'+created.tour.id);
    setData(d);
    return d;
  });

  useEffect(()=>{
    if(tour&&(tour.status==='PREPARING'||tour.status==='READY'))
      api('/tours/'+tour.id+'/production').then(d=>setDraft(d.draft));
  },[tour?.id,tour?.status]);

  // 找到第一个能完整放下动作且默认演员不冲突的格子；找不到就放第 1 幕起点，交给后端判错
  const findFreeCell=(actionId:string,actorId:string,timeline:Entry[])=>{
    const actions:any[]=data?.actions||[];
    const dur=actionById(actions,actionId)?.duration??1;
    for(let a=0;a<ACTS;a++)for(let s=0;s+dur<=SLOTS;s++){
      const clash=timeline.some(e=>e.act===a&&e.actorIds.includes(actorId)&&
        s<e.slot+durationOf(actions,e)&&e.slot<s+dur);
      if(!clash)return{act:a,slot:s};
    }
    return{act:0,slot:0};
  };
  const addAction=(id:string)=>setDraft(x=>{
    const{act:a,slot}=findFreeCell(id,tour.actors[0].id,x.timeline);
    return{...x,timeline:[...x.timeline,{actionId:id,actorIds:[tour.actors[0].id],act:a,slot}]};
  });
  const moveEntry=(i:number,act:number,slot:number)=>
    setDraft(x=>({...x,timeline:x.timeline.map((e,j)=>j===i?{...e,act,slot}:e)}));
  const removeEntry=(i:number)=>setDraft(x=>({...x,timeline:x.timeline.filter((_,j)=>j!==i)}));
  const toggleActor=(i:number,id:string)=>setDraft(x=>({
    ...x,
    timeline:x.timeline.map((e,j)=>j===i?{
      ...e,
      actorIds:e.actorIds.includes(id)?e.actorIds.filter(a=>a!==id):[...e.actorIds,id],
    }:e),
  }));

  // 本地复刻后端占格规则用于高亮提示，最终仍以后端校验为准
  const board=useMemo(()=>{
    const occupancy=new Map<string,number[]>();
    const conflict=new Set<number>();
    const overrun=new Set<number>();
    draft.timeline.forEach((e,i)=>{
      const dur=durationOf(data?.actions||[],e);
      if(e.slot<0||e.slot>=SLOTS||e.act<0||e.act>=ACTS){overrun.add(i);return}
      if(e.slot+dur>SLOTS)overrun.add(i);
      e.actorIds.forEach(id=>{
        for(let s=e.slot;s<e.slot+dur&&s<SLOTS;s++){
          const k=`${id}-${e.act}-${s}`;
          const list=occupancy.get(k)||[];
          list.forEach(j=>{conflict.add(i);conflict.add(j)});
          list.push(i);occupancy.set(k,list);
        }
      });
    });
    return{conflict,overrun};
  },[draft.timeline,data?.actions]);
  const usedActs=useMemo(
    ()=>new Set(draft.timeline.map(e=>e.act).filter(a=>a>=0&&a<ACTS)),
    [draft.timeline]);
  const continuityGap=Array.from({length:ACTS-1},(_,a)=>a)
    .some(a=>!usedActs.has(a)&&usedActs.has(a+1));
  const actorStamina=(id:string)=>draft.timeline.reduce(
    (n,e)=>n+(e.actorIds.includes(id)?(actionById(data?.actions||[],e.actionId)?.stamina||0):0),0);

  const saveProduction=()=>act(async()=>{
    const v=await api('/tours/'+tour.id+'/production/validate',{method:'POST',body:JSON.stringify(draft)});
    if(!v.valid)throw Error(v.errors.join('；'));
    return api('/tours/'+tour.id+'/production',{method:'PUT',body:JSON.stringify(draft)});
  });
  const perform=()=>act(async()=>api('/tours/'+tour.id+'/performances',
    {method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(draft)}));
  const rest=()=>act(async()=>api('/tours/'+tour.id+'/rest',{method:'POST'}));
  const finale=()=>act(async()=>api('/tours/'+tour.id+'/finale',{method:'POST'}));

  if(!tour)return <main className="landing">
    <div className="curtain">
      <span>木偶剧团</span><h1>巡演</h1>
      <p>把一段传说，交给下一座小镇。</p>
      {msg&&<div className="notice">{msg}</div>}
      <button onClick={create}>开始一场新的巡演</button>
    </div>
  </main>;

  const town=data?.town;
  const next=data?.towns?.find((x:any)=>x.id===tour.townIds[tour.stopIndex+1]);
  const travel=()=>next&&act(async()=>api('/tours/'+tour.id+'/travel',
    {method:'POST',body:JSON.stringify({townId:next.id})}));
  const investigate=(kind:string)=>act(async()=>api('/tours/'+tour.id+'/investigations',
    {method:'POST',body:JSON.stringify({kind})}));
  const endings:string[]=data?.plays?.find((p:any)=>p.id===draft.playId)?.endings||[];
  const entriesAt=(a:number,s:number)=>draft.timeline
    .map((e,i)=>({e,i}))
    .filter(({e})=>e.act===a&&e.slot<=s&&s<e.slot+durationOf(data?.actions||[],e));

  return <div className="app">
    <header>
      <div className="brand">木偶剧团巡演</div>
      <div className="stats">
        <b>第 {tour.stopIndex+1} 站</b><span>资金 {tour.funds}</span>
        <span>声望 {tour.reputation}</span><span>灵感 {tour.inspiration}</span>
      </div>
    </header>
    <main className="shell">
      <section className="hero">
        <div>
          <small>{town?.region||'巡演路上'}</small>
          <h1>{tour.status==='COMPLETED'?'巡演落幕':town?.name||'下一站'}</h1>
          <p>{tour.status==='COMPLETED'
            ?(msg||'每一次提线，都会留下回声。')
            :town?`${town.legend} · ${town.audience}`:'选择路线，去遇见新的传说。'}</p>
        </div>
        <div className="status">{tour.status.replaceAll('_',' ')}</div>
      </section>
      {msg&&<div className="notice">{msg}</div>}

      {tour.status==='ROUTE_SELECTION'&&<section className="panel">
        <h2>选择下一站</h2>
        <div className="route">
          <div className="town current"><strong>{town?.name||'起点'}</strong><small>当前剧场</small></div>
          <div className="path">→</div>
          <button className="town choice"onClick={travel}disabled={!next||busy}>
            <strong>{next?.name||'路线已结束'}</strong>
            <small>{next?`旅费 ${Math.max(12,Math.round(next.capacity/8))} · ${next.legend}`:'准备终场'}</small>
          </button>
        </div>
        <button className="secondary"onClick={rest}>让全员休息，恢复 25 体力</button>
        {tour.stopIndex>=tour.townIds.length-1&&<button onClick={finale}>进入终局</button>}
      </section>}

      {tour.status==='INVESTIGATING'&&<section className="panel">
        <h2>在 {town.name} 了解传说</h2>
        <p className="muted">调查会揭示结尾线索，排练则让动作更稳。</p>
        <div className="choices">
          <button onClick={()=>investigate('market')}>逛市集<small>寻找观众口味</small></button>
          <button onClick={()=>investigate('tavern')}>听酒馆故事<small>了解传说禁忌</small></button>
          <button onClick={()=>investigate('shrine')}>拜访神龛<small>确认象征物</small></button>
          <button onClick={()=>investigate('rehearse')}>后台排练<small>不揭示线索</small></button>
        </div>
      </section>}

      {(tour.status==='PREPARING'||tour.status==='READY')&&<section className="grid">
        <div className="panel">
          <h2>选一出戏</h2>
          <div className="play-list">{(data?.plays||[]).map((p:any)=>(
            <button className={draft.playId===p.id?'selected':''}key={p.id}
              onClick={()=>setDraft(x=>({...x,playId:p.id}))}>
              <b>{p.name}</b><small>{p.blurb}</small><em>{p.tags.join(' · ')}</em>
            </button>
          ))}</div>
        </div>

        <div className="panel">
          <h2>编排木偶动作</h2>
          <p className="muted">时间轴为 3 幕 × 每幕 4 拍：长动作连续占位且不能越过幕边界；同一名演员的占位不能重叠；联合托举等协作动作至少需要两名演员；幕间不能跳过空幕。</p>
          <div className="actions">{(data?.actions||[]).map((a:any)=>(
            <button key={a.id}onClick={()=>addAction(a.id)}disabled={busy}>
              {a.name}
              <small>{a.duration} 拍 · {a.stamina} 体力{a.minActors?` · 至少 ${a.minActors} 人`:''}</small>
            </button>
          ))}</div>

          <div className="board">{Array.from({length:ACTS},(_,a)=>(
            <div className={'act-column'+(usedActs.has(a)?'':' empty')+(a>0&&!usedActs.has(a-1)&&usedActs.has(a)?' gap':'')}key={a}>
              <h3>第 {a+1} 幕</h3>
              <div className="slots">{Array.from({length:SLOTS},(_,s)=>(
                <div className="slot"key={s}>
                  <em>拍 {s+1}</em>
                  <div className="slot-cards">{entriesAt(a,s).map(({e,i})=>{
                    const action=actionById(data?.actions||[],e.actionId);
                    const start=e.slot===s;
                    const cls='entry'+(board.conflict.has(i)?' clash':'')
                      +(board.overrun.has(i)?' overrun':'')+(start?'':' tail');
                    return <div className={cls}key={i}
                      style={start?{gridColumn:`span ${Math.min(durationOf(data?.actions||[],e),SLOTS-s)}`}:undefined}>
                      {start?<>
                        <b>{action?.name||'未知动作'}</b><small>{action?.duration} 拍</small>
                        <label>幕<select value={e.act}disabled={busy}
                          onChange={ev=>moveEntry(i,Number(ev.target.value),e.slot)}>
                          {[1,2,3].map(n=><option key={n}value={n-1}>{n}</option>)}
                        </select></label>
                        <label>起拍<select value={e.slot}disabled={busy}
                          onChange={ev=>moveEntry(i,e.act,Number(ev.target.value))}>
                          {Array.from({length:SLOTS},(_,k)=>k+1).map(n=><option key={n}value={n-1}>{n}</option>)}
                        </select></label>
                        <div className="cast">{tour.actors.map((ac:any)=>(
                          <button type="button"key={ac.id}
                            className={e.actorIds.includes(ac.id)?'on':''}
                            disabled={busy}onClick={()=>toggleActor(i,ac.id)}>{ac.name}</button>
                        ))}
                          {action?.minActors&&e.actorIds.length<action.minActors&&
                            <small className="need">至少 {action.minActors} 人协作</small>}
                        </div>
                        <button className="remove"type="button"disabled={busy}onClick={()=>removeEntry(i)}>移除</button>
                      </>:<small className="tail-tag">{action?.name} 占位中</small>}
                    </div>;
                  })}</div>
                </div>
              ))}</div>
            </div>
          ))}</div>

          {(board.conflict.size>0||board.overrun.size>0||continuityGap)&&<ul className="editor-warnings">
            {board.conflict.size>0&&<li>存在演员时间冲突（红色边框）：长动作的每一拍占位都不能与其他动作重叠。</li>}
            {board.overrun.size>0&&<li>有动作越过幕边界（橙色边框）：请把长动作移到更早的拍。</li>}
            {continuityGap&&<li>幕间不能跳过空幕：请先填满前一幕再进入下一幕。</li>}
          </ul>}

          <h3>结尾改写</h3>
          <div className="endings">{[0,1,2].map(slot=>(
            <label key={slot}>第 {slot+1} 幕
              <select value={draft.endings[slot]}
                onChange={e=>setDraft(x=>({...x,endings:x.endings.map((v,i)=>i===slot?Number(e.target.value):v)}))}>
                {endings.map((x,i)=><option key={i}value={i}>{x}</option>)}
              </select>
            </label>
          ))}</div>
          <button onClick={saveProduction}disabled={busy}>保存编排并检查</button>
          {tour.status==='READY'&&<button className="perform"onClick={perform}disabled={busy}>确认演出</button>}
        </div>

        <aside className="panel">
          <h2>剧团状态</h2>
          {tour.actors.map((a:any)=>{
            const used=actorStamina(a.id);
            return <div className="actor"key={a.id}>
              <div><b>{a.name}</b><small>{a.role} · Lv.{a.level}</small></div>
              <meter min="0"max="100"value={a.stamina}/>
              <small className={used>a.stamina+10?'over':''}>体力 {a.stamina} · 本戏已排消耗 {used}</small>
            </div>;
          })}
          <button className="secondary"onClick={rest}>全员休息</button>
        </aside>
      </section>}

      {tour.status==='FINALE_READY'&&<section className="panel finale">
        <h2>终站的帷幕已经升起</h2>
        <p>五座小镇的回声汇聚成最后一场演出。你的选择将决定剧团留下什么。</p>
        <button onClick={finale}disabled={busy}>演出终局</button>
      </section>}

      {perf&&<section className="panel result">
        <h2>演出结算</h2>
        <div className="score">{perf.score}<small> / 100</small></div>
        <p>{perf.feedback}</p>
        <div className="ledger">
          <span>票房 <b>+{perf.income}</b></span>
          <span>已记录为不可变演出快照</span>
        </div>
      </section>}

      {tour.status==='COMPLETED'&&<section className="panel">
        <h2>剧团档案</h2>
        <p>本次巡演走过 {tour.visited.length} 座小镇，留下 {tour.history.length} 场演出记录。</p>
        <button onClick={()=>{localStorage.removeItem('tour');location.reload()}}>开启新的巡演</button>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
