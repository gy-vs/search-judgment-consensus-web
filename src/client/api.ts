export type Grade = 0 | 1 | 2 | 3;
export type Side = 'A' | 'B';
export type PairStatus = 'pending' | 'awaiting' | 'adjudication' | 'final';

export interface Submission {
  grade: Grade | null;
  rationale: string;
  idempotencyKey: string;
  submittedAt: string;
}

export interface FinalDecision {
  grade: Grade | null;
  source: 'consensus' | 'both_skipped' | 'adjudicator';
  note: string;
  by: string | null;
  decidedAt: string;
}

export interface PairView {
  id: string;
  queryId: string;
  docId: string;
  corpusRevision: number;
  status: PairStatus;
  revision: number;
  mine: Submission | null;
  other: {submitted: boolean; submission?: Submission};
  final: FinalDecision | null;
  submissions?: Partial<Record<Side, Submission>>; // 仅协调视图返回
}

export interface QueryRow {id: string; text: string}
export interface DocRow {id: string; title: string; content: string; version: number}
export interface BoardItem {pair: PairView; query: QueryRow; doc: DocRow}
export interface Board {corpusRevision: number; items: BoardItem[]}

export interface Progress {
  corpusRevision: number;
  total: number;
  final: number;
  adjudication: number;
  awaiting: number;
  pending: number;
}

export class ApiError extends Error {
  constructor(public status: number, public body: {error?: string}) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

// fetch 在网络断开时抛 TypeError，用它区分离线（进离线队列）与业务错误（409 等）
export function isNetworkError(err: unknown) {
  return err instanceof TypeError;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

const post = <T,>(url: string, payload: unknown) =>
  req<T>(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});

export interface SubmitPayload {
  queryId: string;
  docId: string;
  corpusRevision: number;
  reviewer: Side;
  grade: Grade | null;
  rationale: string;
  idempotencyKey: string;
}

export interface DecidePayload {
  finalGrade: Grade | null;
  note: string;
  adjudicator: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export const api = {
  board: (reviewer: Side) => req<Board>(`/api/judgments?reviewer=${reviewer}`),
  submitJudgment: (payload: SubmitPayload) => post(`/api/judgments`, payload),
  adjudications: () => req<Board>(`/api/adjudications`),
  decide: (pairId: string, payload: DecidePayload) => post(`/api/adjudications/${encodeURIComponent(pairId)}/decide`, payload),
  progress: () => req<Progress>(`/api/progress`),
};
