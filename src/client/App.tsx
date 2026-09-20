import {useEffect, useRef, useState} from 'react';
import {CheckCircle2, CloudOff, Gavel, Keyboard, RefreshCw, Scale, Undo2, Upload} from 'lucide-react';

type Grade = 0 | 1 | 2 | 3;
const GRADE_OPTIONS: {grade: Grade; label: string; hotkey: string}[] = [
  {grade: 0, label: '无关', hotkey: '0'},
  {grade: 1, label: '勉强', hotkey: '1'},
  {grade: 2, label: '相关', hotkey: '2'},
  {grade: 3, label: '完美', hotkey: '3'},
];
const gradeLabel = (grade: Grade | null, skipped: boolean) =>
  skipped ? '跳过' : grade === null ? '—' : GRADE_OPTIONS[grade].label;

interface Judgment { id: string; reviewer: string; grade: Grade | null; skipped: boolean; rationale: string; corpusRevision: number }
interface Task {
  queryId: string; docId: string; corpusRevision: number;
  query: {id: string; text: string};
  doc: {id: string; title: string; content: string; revision: number};
  myJudgment: Judgment | null;
  partnerSubmitted: boolean;
}
interface Pending {
  taskKey: string; queryId: string; docId: string; corpusRevision: number;
  grade: Grade | null; skipped: boolean; rationale: string; idempotencyKey: string;
}
interface Progress {
  totalPairs: number; neededJudgments: number; validJudgments: number; completePairs: number;
  staleJudgments: number; adjudicationPending: number; adjudicationResolved: number;
}
interface Adjudication {
  id: string; queryId: string; docId: string; corpusRevision: number;
  status: 'pending' | 'resolved'; source: 'agreement' | 'adjudicator' | null;
  finalGrade: Grade | null; finalSkipped: boolean; note: string; revision: number;
  query: {id: string; text: string}; doc: {id: string; title: string; content: string; revision: number};
  judgments: {id: string; reviewer: string; grade: Grade | null; skipped: boolean; rationale: string}[];
}

const taskKey = (t: {queryId: string; docId: string}) => `${t.queryId}:${t.docId}`;
const store = {
  read<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
  },
  write(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时忽略 */ }
  },
};

// 丢弃已提交或语料 revision 已变化的本地选择
function reconcile(list: Pending[], tasks: Task[]) {
  return list.filter(p => {
    const t = tasks.find(x => taskKey(x) === p.taskKey);
    return t && !t.myJudgment && t.corpusRevision === p.corpusRevision;
  });
}

export default function App() {
  const [view, setView] = useState<'judge' | 'adjudicate'>('judge');
  const [reviewer, setReviewer] = useState<string>(() => store.read('jr:reviewer', 'r1'));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [pending, setPending] = useState<Pending[]>(() => store.read(`jr:pending:${reviewer}`, []));
  const [focus, setFocus] = useState<number>(() => store.read(`jr:focus:${reviewer}`, 0));
  const [offline, setOffline] = useState(!navigator.onLine);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => { store.write(`jr:pending:${reviewer}`, pending); }, [pending, reviewer]);
  useEffect(() => { store.write(`jr:focus:${reviewer}`, focus); }, [focus, reviewer]);
  useEffect(() => { rowRefs.current[focus]?.scrollIntoView({block: 'nearest'}); }, [focus]);

  async function refresh(r = reviewer) {
    try {
      const [t, p] = await Promise.all([
        fetch(`/api/tasks?reviewer=${r}`).then(res => res.json() as Promise<Task[]>),
        fetch('/api/progress').then(res => res.json() as Promise<Progress>),
      ]);
      setTasks(t);
      setProgress(p);
      setPending(prev => reconcile(prev, t));
      setOffline(false);
    } catch { setOffline(true); }
  }
  useEffect(() => { void refresh(); }, [reviewer]);

  function switchReviewer(r: string) {
    setReviewer(r);
    store.write('jr:reviewer', r);
    setPending(store.read(`jr:pending:${r}`, []));
    setFocus(store.read(`jr:focus:${r}`, 0));
  }

  function select(grade: Grade | null, skipped: boolean) {
    const task = tasks[focus];
    if (!task || task.myJudgment) return;
    const key = taskKey(task);
    setPending(prev => {
      const existing = prev.find(p => p.taskKey === key);
      const next: Pending = {
        taskKey: key, queryId: task.queryId, docId: task.docId, corpusRevision: task.corpusRevision,
        grade, skipped, rationale: existing?.rationale ?? '',
        idempotencyKey: existing?.idempotencyKey ?? crypto.randomUUID(),
      };
      return [...prev.filter(p => p.taskKey !== key), next];
    });
    setFocus(f => Math.min(f + 1, tasks.length - 1));
  }

  function undo() { setPending(prev => prev.slice(0, -1)); }

  async function flush() {
    if (submitting || pending.length === 0) return;
    setSubmitting(true);
    const remaining: Pending[] = [];
    let staleDropped = 0;
    for (const p of pending) {
      try {
        const res = await fetch('/api/judgments', {
          method: 'POST',
          headers: {'content-type': 'application/json', 'Idempotency-Key': p.idempotencyKey},
          body: JSON.stringify({
            queryId: p.queryId, docId: p.docId, corpusRevision: p.corpusRevision,
            reviewer, grade: p.grade, skipped: p.skipped, rationale: p.rationale,
          }),
        });
        if (res.ok) continue;
        const body = await res.json().catch(() => ({}));
        // 语料更新 / 已提交 / 键冲突：本地选择不再有效，丢弃；其余错误保留待重试
        if (res.status === 409 && ['stale_revision', 'already_submitted', 'idempotency_mismatch'].includes(body.error)) {
          if (body.error === 'stale_revision') staleDropped += 1;
          continue;
        }
        remaining.push(p);
      } catch { remaining.push(p); }
    }
    setPending(remaining);
    setSubmitting(false);
    if (staleDropped > 0) setNotice(`${staleDropped} 条未提交选择因语料更新被丢弃`);
    if (remaining.length > 0) setOffline(true);
    await refresh();
  }

  // 断线恢复：网络恢复后自动重发未提交选择（幂等键保证安全）
  useEffect(() => {
    const onOnline = () => { setOffline(false); void flush(); };
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  });

  // 键盘批量判断：0-3 打等级，s 跳过，u 撤销，Enter 提交，j/k 或方向键移动
  useEffect(() => {
    if (view !== 'judge') return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const option = GRADE_OPTIONS.find(o => o.hotkey === e.key);
      if (option) { select(option.grade, false); e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowDown': case 'j': setFocus(f => Math.min(f + 1, tasks.length - 1)); break;
        case 'ArrowUp': case 'k': setFocus(f => Math.max(f - 1, 0)); break;
        case 's': select(null, true); break;
        case 'u': undo(); break;
        case 'Enter': void flush(); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function replaceFocusedDoc() {
    const task = tasks[focus];
    if (!task) return;
    await fetch(`/api/corpus/documents/${task.docId}/replace`, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: `${task.doc.content} [replaced ${new Date().toISOString()}]`}),
    });
    setNotice(`文档 ${task.docId} 已在语料中替换，旧判断不再适用`);
    await refresh();
  }

  const focusedTask = tasks[focus];
  const focusedPending = focusedTask ? pending.find(p => p.taskKey === taskKey(focusedTask)) : undefined;

  return (
    <main className="shell">
      <header className="topbar">
        <Scale size={20}/>
        <strong>搜索相关性评审工作台</strong>
        <nav className="tabs">
          <button className={view === 'judge' ? 'active' : ''} onClick={() => setView('judge')}><Keyboard size={14}/>评审</button>
          <button className={view === 'adjudicate' ? 'active' : ''} onClick={() => setView('adjudicate')}><Gavel size={14}/>协调{progress && progress.adjudicationPending > 0 ? ` (${progress.adjudicationPending})` : ''}</button>
        </nav>
        {progress && (
          <span className="progress-summary">
            有效判断 {progress.validJudgments}/{progress.neededJudgments} · 完成 {progress.completePairs}/{progress.totalPairs} 对 · 待协调 {progress.adjudicationPending}
            {progress.staleJudgments > 0 && <em> · {progress.staleJudgments} 条旧 revision 判断已失效</em>}
          </span>
        )}
        {offline && <span className="offline"><CloudOff size={14}/>离线，待恢复后自动重发</span>}
      </header>

      {view === 'judge' ? (
        <section className="workspace judge-layout">
          <aside className="pane">
            <h2>评审身份</h2>
            <div className="list">
              {['r1', 'r2'].map(r => (
                <button key={r} className={r === reviewer ? 'active' : ''} onClick={() => switchReviewer(r)}>
                  评审 {r}<br/><small>双方互不可见，提交后锁定</small>
                </button>
              ))}
            </div>
            <h2>快捷键</h2>
            <ul className="hints">
              <li><code>0-3</code> 打等级，自动跳下一条</li>
              <li><code>s</code> 跳过 · <code>u</code> 撤销未提交</li>
              <li><code>Enter</code> 批量提交 · <code>j/k</code> 移动焦点</li>
            </ul>
          </aside>

          <section className="pane">
            <div className="toolbar">
              <button className="primary" onClick={() => void flush()} disabled={pending.length === 0 || submitting}>
                <Upload size={15}/>{submitting ? '提交中…' : `提交 ${pending.length} 条`}
              </button>
              <button onClick={undo} disabled={pending.length === 0}><Undo2 size={15}/>撤销</button>
              <button onClick={() => void refresh()}><RefreshCw size={15}/>刷新</button>
              <button onClick={() => void replaceFocusedDoc()} title="模拟语料中文档被替换">替换当前文档</button>
              <span>{notice}</span>
            </div>
            <div className="task-list">
              {tasks.map((task, i) => {
                const p = pending.find(x => x.taskKey === taskKey(task));
                return (
                  <div key={taskKey(task)} ref={el => { rowRefs.current[i] = el; }}
                       className={`task-row ${i === focus ? 'focused' : ''} ${task.myJudgment ? 'submitted' : ''} ${p ? 'pending' : ''}`}
                       onClick={() => setFocus(i)}>
                    <div className="task-main">
                      <div className="task-query">{task.query.text} <span className="pill">语料 r{task.corpusRevision}</span></div>
                      <div className="task-doc"><strong>{task.doc.title}</strong> — {task.doc.content}</div>
                      <div className="task-state">
                        {task.myJudgment
                          ? <><CheckCircle2 size={13}/> 已提交：{gradeLabel(task.myJudgment.grade, task.myJudgment.skipped)}{task.partnerSubmitted && ' · 对方已提交'}</>
                          : p ? <>待提交：{gradeLabel(p.grade, p.skipped)}</> : '未判断'}
                      </div>
                    </div>
                    <div className="grade-buttons" onClick={e => e.stopPropagation()}>
                      {GRADE_OPTIONS.map(o => (
                        <button key={o.grade} disabled={Boolean(task.myJudgment)}
                                className={p && !p.skipped && p.grade === o.grade ? 'active' : ''}
                                onClick={() => { setFocus(i); select(o.grade, false); }}>
                          {o.hotkey} {o.label}
                        </button>
                      ))}
                      <button disabled={Boolean(task.myJudgment)} className={p?.skipped ? 'active' : ''}
                              onClick={() => { setFocus(i); select(null, true); }}>s 跳过</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="pane">
            <h2>当前条目</h2>
            {focusedTask ? (
              <>
                <span className="pill">{focusedTask.queryId} × {focusedTask.docId} · r{focusedTask.corpusRevision}</span>
                <p><strong>{focusedTask.query.text}</strong></p>
                <p>{focusedTask.doc.content}</p>
                {focusedPending && (
                  <>
                    <h2>理由（可选）</h2>
                    <textarea aria-label="理由" rows={4} value={focusedPending.rationale}
                              placeholder="提交前可补充理由，协调视图会展示"
                              onChange={e => setPending(prev => prev.map(p => p.taskKey === focusedPending.taskKey ? {...p, rationale: e.target.value} : p))}/>
                  </>
                )}
                {focusedTask.myJudgment && (
                  <>
                    <h2>我的提交</h2>
                    <p>{gradeLabel(focusedTask.myJudgment.grade, focusedTask.myJudgment.skipped)}</p>
                    <p>{focusedTask.myJudgment.rationale || '（无理由）'}</p>
                  </>
                )}
              </>
            ) : <p>无条目</p>}
          </aside>
        </section>
      ) : (
        <AdjudicationPanel onChanged={() => void refresh()}/>
      )}
    </main>
  );
}

function AdjudicationPanel({onChanged}: {onChanged: () => void}) {
  const [items, setItems] = useState<Adjudication[]>([]);
  const [drafts, setDrafts] = useState<Record<string, {grade: Grade | null; skipped: boolean; note: string}>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});

  async function load() {
    const res = await fetch('/api/adjudications');
    setItems(await res.json());
  }
  useEffect(() => { void load(); }, []);

  const draftOf = (a: Adjudication) => drafts[a.id] ?? {grade: null, skipped: false, note: ''};
  const setDraft = (id: string, patch: Partial<{grade: Grade | null; skipped: boolean; note: string}>) =>
    setDrafts(prev => ({...prev, [id]: {...(prev[id] ?? {grade: null, skipped: false, note: ''}), ...patch}}));

  async function resolve(a: Adjudication) {
    const d = draftOf(a);
    if (!d.skipped && d.grade === null) {
      setMessages(m => ({...m, [a.id]: '请选择最终等级或跳过'}));
      return;
    }
    const res = await fetch(`/api/adjudications/${a.id}`, {
      method: 'PUT', headers: {'content-type': 'application/json'},
      body: JSON.stringify({finalGrade: d.skipped ? null : d.grade, finalSkipped: d.skipped, note: d.note, revision: a.revision}),
    });
    if (res.status === 409) {
      setMessages(m => ({...m, [a.id]: '协调结论已被他人修改，已为你刷新最新状态'}));
      await load();
      return;
    }
    setMessages(m => { const next = {...m}; delete next[a.id]; return next; });
    await load();
    onChanged();
  }

  const ordered = [...items].sort((a, b) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : 1));

  return (
    <section className="workspace adjudicate-layout">
      <section className="pane">
        <div className="toolbar">
          <h2 style={{margin: 0}}>分歧协调</h2>
          <button onClick={() => void load()}><RefreshCw size={15}/>刷新</button>
          <span>只处理双方提交后的分歧；原始提交保持只读</span>
        </div>
        {ordered.length === 0 && <p>暂无协调单。双方都提交后，分歧会自动出现在这里。</p>}
        {ordered.map(a => (
          <div key={a.id} className={`adj-card ${a.status}`}>
            <div className="adj-head">
              <strong>{a.query.text}</strong>
              <span className="pill">{a.doc.title} · 语料 r{a.corpusRevision}</span>
            </div>
            <p className="task-doc">{a.doc.content}</p>
            <div className="adj-sides">
              {a.judgments.map(j => (
                <div key={j.id} className="adj-side">
                  <strong>评审 {j.reviewer}</strong>
                  <span className="pill">{gradeLabel(j.grade, j.skipped)}</span>
                  <p>{j.rationale || '（无理由）'}</p>
                </div>
              ))}
            </div>
            {a.status === 'pending' ? (
              <div className="adj-resolve">
                <div className="grade-buttons">
                  {GRADE_OPTIONS.map(o => (
                    <button key={o.grade} className={draftOf(a).grade === o.grade && !draftOf(a).skipped ? 'active' : ''}
                            onClick={() => setDraft(a.id, {grade: o.grade, skipped: false})}>{o.label}</button>
                  ))}
                  <button className={draftOf(a).skipped ? 'active' : ''} onClick={() => setDraft(a.id, {skipped: true, grade: null})}>跳过</button>
                </div>
                <input placeholder="协调说明" value={draftOf(a).note} onChange={e => setDraft(a.id, {note: e.target.value})}/>
                <button className="primary" onClick={() => void resolve(a)}><Gavel size={15}/>定稿</button>
                {messages[a.id] && <span className="conflict">{messages[a.id]}</span>}
              </div>
            ) : (
              <div className="adj-final">
                最终：{gradeLabel(a.finalGrade, a.finalSkipped)}
                <span className="pill">{a.source === 'agreement' ? '双方一致' : '协调定稿'}</span>
                {a.note && <span> · {a.note}</span>}
              </div>
            )}
          </div>
        ))}
      </section>
    </section>
  );
}
