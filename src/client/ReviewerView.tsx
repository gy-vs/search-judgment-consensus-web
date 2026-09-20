import {useCallback, useEffect, useRef, useState} from 'react';
import {RotateCcw, Send, WifiOff} from 'lucide-react';
import {api, ApiError, Board, BoardItem, Grade, isNetworkError, PairView, Side, SubmitPayload} from './api';
import {Draft, loadDrafts, loadFocus, loadOutbox, pushOutbox, saveDrafts, saveFocus, saveOutbox, uuid} from './local';

const GRADE_LABELS: Record<number, string> = {0: '不相关', 1: '一般', 2: '相关', 3: '高度相关'};
const STATUS_LABELS: Record<PairView['status'], string> = {pending: '待评审', awaiting: '等待对方', adjudication: '待协调', final: '已定案'};

function gradeLabel(grade: Grade | null | undefined) {
  if (grade === undefined) return '—';
  if (grade === null) return '跳过';
  return `${grade} ${GRADE_LABELS[grade]}`;
}

const judgeable = (pair: PairView) => !pair.mine && (pair.status === 'pending' || pair.status === 'awaiting');

export default function ReviewerView({reviewer, onProgress}: {reviewer: Side; onProgress: () => void}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [outboxCount, setOutboxCount] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const rev = board?.corpusRevision;

  const reload = useCallback(async () => {
    setBoard(await api.board(reviewer));
  }, [reviewer]);

  // 初始加载：恢复该评审在当前语料 revision 下的未提交选择与焦点位置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await api.board(reviewer);
      if (cancelled) return;
      setBoard(next);
      setDrafts(loadDrafts(reviewer, next.corpusRevision));
      const saved = loadFocus(reviewer, next.corpusRevision);
      setFocusId(saved && next.items.some(i => i.pair.id === saved) ? saved : next.items[0]?.pair.id ?? null);
      setOutboxCount(loadOutbox(reviewer).length);
    })().catch(() => setMessage('加载失败，请确认服务在线'));
    return () => {
      cancelled = true;
    };
  }, [reviewer]);

  // 未提交选择与焦点实时落盘，刷新页面后恢复
  useEffect(() => {
    if (rev != null) saveDrafts(reviewer, rev, drafts);
  }, [drafts, reviewer, rev]);
  useEffect(() => {
    if (rev != null && focusId) saveFocus(reviewer, rev, focusId);
  }, [focusId, reviewer, rev]);
  useEffect(() => {
    if (focusId) rowRefs.current.get(focusId)?.scrollIntoView({block: 'nearest'});
  }, [focusId]);

  // 断线期间进入离线队列的提交，恢复联网后按原幂等键重放
  const flushOutbox = useCallback(async () => {
    const queue = loadOutbox(reviewer);
    if (!queue.length) return false;
    const remaining: SubmitPayload[] = [];
    for (const [index, payload] of queue.entries()) {
      try {
        await api.submitJudgment(payload);
      } catch (err) {
        if (isNetworkError(err)) {
          remaining.push(...queue.slice(index));
          break;
        }
        // 409（已提交/语料已更新）：服务端已有定论，丢弃本地副本
      }
    }
    saveOutbox(reviewer, remaining);
    setOutboxCount(remaining.length);
    return remaining.length < queue.length;
  }, [reviewer]);

  useEffect(() => {
    const sync = () => {
      flushOutbox().then(sent => {
        if (sent) {
          reload().catch(() => {});
          onProgress();
        }
      });
    };
    sync();
    const timer = setInterval(sync, 5000);
    window.addEventListener('online', sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', sync);
    };
  }, [flushOutbox, reload, onProgress]);

  const advance = useCallback(
    (fromId: string) => {
      if (!board) return;
      const index = board.items.findIndex(i => i.pair.id === fromId);
      const next = board.items.slice(index + 1).find(i => judgeable(i.pair) || drafts[i.pair.id]);
      setFocusId((next ?? board.items[Math.min(index + 1, board.items.length - 1)]).pair.id);
    },
    [board, drafts],
  );

  const setGrade = useCallback(
    (item: BoardItem, grade: Grade | null) => {
      if (!judgeable(item.pair)) return;
      setDrafts(prev => ({
        ...prev,
        [item.pair.id]: {grade, rationale: prev[item.pair.id]?.rationale ?? '', idempotencyKey: prev[item.pair.id]?.idempotencyKey ?? uuid()},
      }));
      advance(item.pair.id);
    },
    [advance],
  );

  const setRationale = useCallback((pairId: string, rationale: string) => {
    setDrafts(prev => ({...prev, [pairId]: {grade: prev[pairId]?.grade, rationale, idempotencyKey: prev[pairId]?.idempotencyKey ?? uuid()}}));
  }, []);

  const undoDraft = useCallback((pairId: string) => {
    setDrafts(prev => {
      const next = {...prev};
      delete next[pairId];
      return next;
    });
  }, []);

  const submitAll = useCallback(async () => {
    if (!board) return;
    const entries = Object.entries(drafts).filter(([, d]) => d.grade !== undefined);
    if (!entries.length) {
      setMessage('没有待提交的选择');
      return;
    }
    setMessage('提交中…');
    const remaining = {...drafts};
    let stale = false;
    let offline = false;
    for (const [pairId, draft] of entries) {
      const [queryId, docId] = pairId.split(':');
      const payload: SubmitPayload = {
        queryId,
        docId,
        corpusRevision: board.corpusRevision,
        reviewer,
        grade: draft.grade ?? null,
        rationale: draft.rationale,
        idempotencyKey: draft.idempotencyKey,
      };
      try {
        await api.submitJudgment(payload);
        delete remaining[pairId];
      } catch (err) {
        if (isNetworkError(err)) {
          pushOutbox(reviewer, payload);
          delete remaining[pairId];
          offline = true;
        } else if (err instanceof ApiError && err.body.error === 'stale_revision') {
          stale = true; // 语料已更新：保留草稿太危险，刷新后按新内容重新判断
          delete remaining[pairId];
        } else if (err instanceof ApiError && err.body.error === 'already_submitted') {
          delete remaining[pairId];
        } else {
          throw err;
        }
      }
    }
    setDrafts(remaining);
    setOutboxCount(loadOutbox(reviewer).length);
    setMessage(stale ? '语料已更新，列表已刷新，请按新内容重新判断' : offline ? '网络断开，选择已存入离线队列，恢复后自动同步' : '已提交');
    await reload().catch(() => setMessage('已提交，但刷新列表失败（离线中）'));
    onProgress();
  }, [board, drafts, reviewer, reload, onProgress]);

  // 键盘批量判断：0-3 定级，S 跳过，U 撤销未提交，↑↓/JK 移动，Enter 提交全部
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      if (!board || !focusId) return;
      const index = board.items.findIndex(i => i.pair.id === focusId);
      if (index < 0) return;
      const item = board.items[index];
      if (event.key >= '0' && event.key <= '3') {
        setGrade(item, Number(event.key) as Grade);
      } else if (event.key === 's' || event.key === 'S') {
        setGrade(item, null);
      } else if (event.key === 'u' || event.key === 'U') {
        undoDraft(focusId);
      } else if (event.key === 'ArrowDown' || event.key === 'j') {
        setFocusId(board.items[Math.min(index + 1, board.items.length - 1)].pair.id);
        event.preventDefault();
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        setFocusId(board.items[Math.max(index - 1, 0)].pair.id);
        event.preventDefault();
      } else if (event.key === 'Enter') {
        submitAll();
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [board, focusId, setGrade, undoDraft, submitAll]);

  if (!board) return <section className="workspace single"><div className="pane">加载中…</div></section>;
  const pendingCount = Object.values(drafts).filter(d => d.grade !== undefined).length;

  return (
    <section className="workspace single">
      <div className="pane">
        <div className="toolbar">
          <strong>评审 {reviewer}</strong>
          <span className="pill">语料 r{board.corpusRevision}</span>
          <button className="primary" onClick={submitAll} disabled={!pendingCount}>
            <Send size={14}/>提交全部（{pendingCount}）
          </button>
          {outboxCount > 0 && <span className="pill warn"><WifiOff size={12}/>离线待同步 {outboxCount}</span>}
          <span className="status">{message}</span>
        </div>
        <p className="hint">键盘：0-3 打等级 · S 跳过 · U 撤销未提交 · ↑/↓ 或 J/K 移动 · Enter 提交全部。未提交的选择与焦点位置已本地保存，刷新后自动恢复。</p>
        <div className="rows">
          {board.items.map(item => (
            <Row
              key={item.pair.id}
              item={item}
              draft={drafts[item.pair.id]}
              focused={item.pair.id === focusId}
              onFocus={() => setFocusId(item.pair.id)}
              onGrade={grade => setGrade(item, grade)}
              onUndo={() => undoDraft(item.pair.id)}
              onRationale={text => setRationale(item.pair.id, text)}
              rowRef={el => {
                if (el) rowRefs.current.set(item.pair.id, el);
                else rowRefs.current.delete(item.pair.id);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function Row(props: {
  item: BoardItem;
  draft?: Draft;
  focused: boolean;
  onFocus: () => void;
  onGrade: (grade: Grade | null) => void;
  onUndo: () => void;
  onRationale: (text: string) => void;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const {item, draft, focused} = props;
  const {pair, query, doc} = item;
  const open = judgeable(pair);
  return (
    <div ref={props.rowRef} className={`row${focused ? ' focused' : ''}${draft?.grade !== undefined ? ' has-draft' : ''}`} onClick={props.onFocus}>
      <div className="row-main">
        <div className="q">{query.text}</div>
        <div className="d">{doc.title} — {doc.content}</div>
      </div>
      <div className="row-side">
        <span className={`badge ${pair.status}`}>{STATUS_LABELS[pair.status]}</span>
        {pair.mine && <span className="pill">我的提交：{gradeLabel(pair.mine.grade)}</span>}
        {pair.other.submitted && !pair.other.submission && <span className="pill">对方已提交</span>}
        {pair.other.submission && <span className="pill">对方：{gradeLabel(pair.other.submission.grade)}</span>}
        {pair.final && <span className="pill ok">最终：{gradeLabel(pair.final.grade)}</span>}
        {draft?.grade !== undefined && <span className="pill draft">未提交：{gradeLabel(draft.grade)}</span>}
        {open && (
          <span className="grades" onClick={e => e.stopPropagation()}>
            {([0, 1, 2, 3] as Grade[]).map(g => (
              <button key={g} className={draft?.grade === g ? 'sel' : ''} onClick={() => props.onGrade(g)} title={GRADE_LABELS[g]}>
                {g}
              </button>
            ))}
            <button className={draft?.grade === null ? 'sel' : ''} onClick={() => props.onGrade(null)}>跳过</button>
            {draft && (
              <button title="撤销未提交选择" onClick={props.onUndo}>
                <RotateCcw size={13}/>
              </button>
            )}
          </span>
        )}
      </div>
      {focused && open && (
        <textarea
          placeholder="判断理由（随提交一起保存，刷新不丢）"
          value={draft?.rationale ?? ''}
          onChange={e => props.onRationale(e.target.value)}
          onClick={e => e.stopPropagation()}
        />
      )}
    </div>
  );
}
