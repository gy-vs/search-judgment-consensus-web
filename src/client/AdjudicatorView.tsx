import {useCallback, useEffect, useState} from 'react';
import {Scale} from 'lucide-react';
import {api, ApiError, Board, BoardItem, Grade, isNetworkError} from './api';
import {clearAdjKey, loadAdjKey, saveAdjKey, uuid} from './local';

const GRADE_LABELS: Record<number, string> = {0: '不相关', 1: '一般', 2: '相关', 3: '高度相关'};
const gradeLabel = (grade: Grade | null) => (grade === null ? '跳过' : `${grade} ${GRADE_LABELS[grade]}`);

interface Choice {
  grade?: Grade | null;
  note: string;
}

export default function AdjudicatorView({onProgress}: {onProgress: () => void}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [message, setMessage] = useState('');

  const reload = useCallback(async () => {
    setBoard(await api.adjudications());
  }, []);

  useEffect(() => {
    reload().catch(() => setMessage('加载失败，请确认服务在线'));
  }, [reload]);

  const setChoice = (pairId: string, patch: Partial<Choice>) =>
    setChoices(prev => ({...prev, [pairId]: {grade: prev[pairId]?.grade, note: prev[pairId]?.note ?? '', ...patch}}));

  async function decide(item: BoardItem) {
    const choice = choices[item.pair.id];
    if (!choice || choice.grade === undefined) {
      setMessage('请先为该分歧选择最终等级');
      return;
    }
    // 幂等键按对子持久化：断线重试或刷新后重发仍是同一次定案
    let idempotencyKey = loadAdjKey(item.pair.id);
    if (!idempotencyKey) {
      idempotencyKey = uuid();
      saveAdjKey(item.pair.id, idempotencyKey);
    }
    try {
      await api.decide(item.pair.id, {
        finalGrade: choice.grade,
        note: choice.note,
        adjudicator: 'coordinator',
        expectedRevision: item.pair.revision,
        idempotencyKey,
      });
      clearAdjKey(item.pair.id);
      setChoices(prev => {
        const next = {...prev};
        delete next[item.pair.id];
        return next;
      });
      setMessage('已定案，原始双方提交保持不变');
      await reload();
      onProgress();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setMessage(err.body.error === 'already_final' ? '该分歧已被其他协调者定案' : '该分歧刚被修改，已刷新为最新状态');
        await reload();
        onProgress();
      } else if (isNetworkError(err)) {
        setMessage('网络断开：定案结果未确认，恢复后点击重试会自动复用同一幂等键');
      } else {
        throw err;
      }
    }
  }

  if (!board) return <section className="workspace single"><div className="pane">加载中…</div></section>;

  return (
    <section className="workspace single">
      <div className="pane">
        <div className="toolbar">
          <strong><Scale size={16}/> 协调裁决</strong>
          <span className="pill">语料 r{board.corpusRevision}</span>
          <span className="pill">{board.items.length} 个分歧待处理</span>
          <span className="status">{message}</span>
        </div>
        <p className="hint">仅处理双方不一致的对子。定案只生成最终判断，不会改动两位评审的原始提交。</p>
        {!board.items.length && <p className="empty">当前没有待协调的分歧。</p>}
        <div className="rows">
          {board.items.map(item => {
            const choice = choices[item.pair.id];
            const a = item.pair.submissions?.A;
            const b = item.pair.submissions?.B;
            return (
              <div key={item.pair.id} className="row">
                <div className="row-main">
                  <div className="q">{item.query.text}</div>
                  <div className="d">{item.doc.title} — {item.doc.content}</div>
                </div>
                <div className="cols">
                  <div className="sidebox">
                    <h4>评审 A：{a ? gradeLabel(a.grade) : '—'}</h4>
                    <p>{a?.rationale || '（无理由）'}</p>
                  </div>
                  <div className="sidebox">
                    <h4>评审 B：{b ? gradeLabel(b.grade) : '—'}</h4>
                    <p>{b?.rationale || '（无理由）'}</p>
                  </div>
                </div>
                <div className="decide">
                  <span className="grades">
                    {([0, 1, 2, 3] as Grade[]).map(g => (
                      <button key={g} className={choice?.grade === g ? 'sel' : ''} onClick={() => setChoice(item.pair.id, {grade: g})} title={GRADE_LABELS[g]}>
                        {g}
                      </button>
                    ))}
                    <button className={choice?.grade === null ? 'sel' : ''} onClick={() => setChoice(item.pair.id, {grade: null})}>跳过</button>
                  </span>
                  <input
                    placeholder="定案说明（可选）"
                    value={choice?.note ?? ''}
                    onChange={e => setChoice(item.pair.id, {note: e.target.value})}
                  />
                  <button className="primary" onClick={() => decide(item)}>定案</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
