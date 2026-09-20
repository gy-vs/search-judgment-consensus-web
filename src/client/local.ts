import type {Side, SubmitPayload} from './api';

// 未提交的本地选择：grade 为 undefined 表示只写了理由还没定级
export interface Draft {
  grade?: 0 | 1 | 2 | 3 | null;
  rationale: string;
  idempotencyKey: string; // 创建草稿时生成，重试/刷新/断线重放都复用它
}

export function uuid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用（隐私模式等）时静默降级，仅丢失断线恢复能力
  }
}

// 草稿与焦点按 (评审员, 语料 revision) 隔离：语料更新后旧草稿自然失效，不会套到新内容
export const loadDrafts = (reviewer: Side, rev: number) => read<Record<string, Draft>>(`srl:drafts:${reviewer}:${rev}`, {});
export const saveDrafts = (reviewer: Side, rev: number, drafts: Record<string, Draft>) => write(`srl:drafts:${reviewer}:${rev}`, drafts);

export const loadFocus = (reviewer: Side, rev: number) => read<string | null>(`srl:focus:${reviewer}:${rev}`, null);
export const saveFocus = (reviewer: Side, rev: number, pairId: string) => write(`srl:focus:${reviewer}:${rev}`, pairId);

export const loadOutbox = (reviewer: Side) => read<SubmitPayload[]>(`srl:outbox:${reviewer}`, []);
export const saveOutbox = (reviewer: Side, queue: SubmitPayload[]) => write(`srl:outbox:${reviewer}`, queue);
export function pushOutbox(reviewer: Side, payload: SubmitPayload) {
  const queue = loadOutbox(reviewer).filter(p => p.idempotencyKey !== payload.idempotencyKey);
  saveOutbox(reviewer, [...queue, payload]);
}

// 协调定案的幂等键按对子保存，断线重试/刷新后复用同一键
export const loadAdjKey = (pairId: string) => read<string | null>(`srl:adjkey:${pairId}`, null);
export const saveAdjKey = (pairId: string, key: string) => write(`srl:adjkey:${pairId}`, key);
export const clearAdjKey = (pairId: string) => {
  try {
    localStorage.removeItem(`srl:adjkey:${pairId}`);
  } catch {
    // 同上，静默降级
  }
};
