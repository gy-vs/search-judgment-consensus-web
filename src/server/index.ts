import express from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export type Grade = 0 | 1 | 2 | 3;
export type Reviewer = 'r1' | 'r2';
export const REVIEWERS: Reviewer[] = ['r1', 'r2'];

export interface Judgment {
  id: string;
  queryId: string;
  docId: string;
  corpusRevision: number;
  reviewer: Reviewer;
  grade: Grade | null; // null 表示跳过
  skipped: boolean;
  rationale: string;
  idempotencyKey: string;
  createdAt: string;
}

interface QueryRow { id: string; text: string }
interface DocRow { id: string; title: string; content: string; revision: number; updatedAt: string }
interface AdjudicationRow {
  id: string; // `${queryId}:${docId}:${corpusRevision}`
  queryId: string;
  docId: string;
  corpusRevision: number;
  status: 'pending' | 'resolved';
  source: 'agreement' | 'adjudicator' | null;
  finalGrade: Grade | null;
  finalSkipped: boolean;
  note: string;
  revision: number; // 乐观锁，协调者并发编辑保护
  updatedAt: string;
}

function seed() {
  const queries: QueryRow[] = [
    {id: 'q1', text: 'wireless noise cancelling headphones'},
    {id: 'q2', text: 'waterproof hiking boots'},
    {id: 'q3', text: 'typescript generic constraints'},
  ];
  const documents: DocRow[] = [
    {id: 'd1', title: 'Acme SilentBuds Pro', content: 'Wireless over-ear headphones with active noise cancellation.', revision: 1, updatedAt: new Date(0).toISOString()},
    {id: 'd2', title: 'SoundLab HB-2', content: 'Budget wired earbuds for casual listening.', revision: 1, updatedAt: new Date(0).toISOString()},
    {id: 'd3', title: 'TrailMaster GTX', content: 'Waterproof leather hiking boots with Gore-Tex lining.', revision: 1, updatedAt: new Date(0).toISOString()},
    {id: 'd4', title: 'CityWalk Sneakers', content: 'Lightweight everyday sneakers, not waterproof.', revision: 1, updatedAt: new Date(0).toISOString()},
    {id: 'd5', title: 'TS Handbook Notes', content: 'Notes on TypeScript generics, constraints and variance.', revision: 1, updatedAt: new Date(0).toISOString()},
  ];
  const pairs = [
    {queryId: 'q1', docId: 'd1'},
    {queryId: 'q1', docId: 'd2'},
    {queryId: 'q2', docId: 'd3'},
    {queryId: 'q2', docId: 'd4'},
    {queryId: 'q3', docId: 'd5'},
    {queryId: 'q3', docId: 'd1'},
  ];
  return {queries, documents, pairs};
}

function parseGrade(value: unknown): Grade | null | undefined {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 0 && n <= 3) return n as Grade;
  return undefined;
}

export function createApp() {
  const {queries, documents, pairs} = seed();
  const judgments: Judgment[] = [];
  const idempotency = new Map<string, string>(); // `${reviewer}:${key}` -> judgmentId
  const adjudications = new Map<string, AdjudicationRow>();

  const app = express();
  app.use(express.json({limit: '1mb'}));

  const docOf = (id: string) => documents.find(d => d.id === id);
  const queryOf = (id: string) => queries.find(q => q.id === id);
  const judgmentFor = (reviewer: Reviewer, queryId: string, docId: string, rev: number) =>
    judgments.find(j => j.reviewer === reviewer && j.queryId === queryId && j.docId === docId && j.corpusRevision === rev);
  const pairJudgments = (queryId: string, docId: string, rev: number) =>
    REVIEWERS.map(r => judgmentFor(r, queryId, docId, rev));

  function hydrateAdjudication(a: AdjudicationRow) {
    return {
      ...a,
      query: queryOf(a.queryId),
      doc: docOf(a.docId),
      judgments: pairJudgments(a.queryId, a.docId, a.corpusRevision)
        .filter((j): j is Judgment => Boolean(j))
        .map(j => ({id: j.id, reviewer: j.reviewer, grade: j.grade, skipped: j.skipped, rationale: j.rationale})),
    };
  }

  // 双方都提交后生成协调单：一致则直接定稿，分歧进入待协调队列
  function maybeAdjudicate(queryId: string, docId: string, rev: number) {
    const [a, b] = pairJudgments(queryId, docId, rev);
    if (!a || !b) return;
    const id = `${queryId}:${docId}:${rev}`;
    if (adjudications.has(id)) return;
    const agree = a.skipped === b.skipped && (a.skipped || a.grade === b.grade);
    adjudications.set(id, {
      id, queryId, docId, corpusRevision: rev,
      status: agree ? 'resolved' : 'pending',
      source: agree ? 'agreement' : null,
      finalGrade: agree ? a.grade : null,
      finalSkipped: agree ? a.skipped : false,
      note: '',
      revision: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'search-relevance', reviewers: REVIEWERS, pairs: pairs.length}));

  // 评审视图：只返回自己的判断；提交前看不到对方任何信息，提交后也仅知道对方"已提交"
  app.get('/api/tasks', (req, res) => {
    const reviewer = String(req.query.reviewer ?? '');
    if (!REVIEWERS.includes(reviewer as Reviewer)) return res.status(400).json({error: 'unknown_reviewer'});
    const me = reviewer as Reviewer;
    res.json(pairs.map(p => {
      const doc = docOf(p.docId)!;
      const mine = judgmentFor(me, p.queryId, p.docId, doc.revision);
      const partner = judgmentFor(me === 'r1' ? 'r2' : 'r1', p.queryId, p.docId, doc.revision);
      return {
        queryId: p.queryId,
        docId: p.docId,
        corpusRevision: doc.revision,
        query: queryOf(p.queryId),
        doc,
        myJudgment: mine ?? null,
        partnerSubmitted: mine ? Boolean(partner) : false,
      };
    }));
  });

  // 独立提交：按 (query, doc, corpusRevision) 锁定对象，Idempotency-Key 保证幂等
  app.post('/api/judgments', (req, res) => {
    const body = req.body ?? {};
    const {queryId, docId, corpusRevision} = body;
    const reviewer = String(body.reviewer ?? '');
    const key = req.header('Idempotency-Key');
    if (!REVIEWERS.includes(reviewer as Reviewer)) return res.status(400).json({error: 'unknown_reviewer'});
    if (!key) return res.status(400).json({error: 'missing_idempotency_key'});
    const doc = docOf(String(docId));
    if (!doc || !queryOf(String(queryId))) return res.status(404).json({error: 'not_found'});
    const skipped = Boolean(body.skipped);
    const grade = skipped ? null : parseGrade(body.grade);
    if (grade === undefined) return res.status(400).json({error: 'invalid_grade'});
    const rationale = String(body.rationale ?? '');

    // 幂等重放：同一键返回首次结果（即使语料已更新，也返回原始判断而不是 409）
    const idemId = `${reviewer}:${key}`;
    const existingId = idempotency.get(idemId);
    if (existingId) {
      const existing = judgments.find(j => j.id === existingId)!;
      const samePayload = existing.queryId === queryId && existing.docId === docId &&
        existing.corpusRevision === corpusRevision && existing.grade === grade &&
        existing.skipped === skipped && existing.rationale === rationale;
      if (!samePayload) return res.status(409).json({error: 'idempotency_mismatch'});
      return res.status(200).json({judgment: existing, deduplicated: true});
    }

    // 语料 revision 锁定：文档被替换后，旧 revision 的判断不能套到新内容
    if (doc.revision !== corpusRevision) {
      return res.status(409).json({error: 'stale_revision', currentRevision: doc.revision});
    }
    if (judgmentFor(reviewer as Reviewer, String(queryId), String(docId), doc.revision)) {
      return res.status(409).json({error: 'already_submitted'});
    }

    const judgment: Judgment = {
      id: randomUUID(), queryId: String(queryId), docId: String(docId), corpusRevision: doc.revision,
      reviewer: reviewer as Reviewer, grade, skipped, rationale, idempotencyKey: key,
      createdAt: new Date().toISOString(),
    };
    judgments.push(judgment);
    idempotency.set(idemId, judgment.id);
    maybeAdjudicate(judgment.queryId, judgment.docId, judgment.corpusRevision);
    res.status(201).json({judgment});
  });

  // 协调视图：展示双方等级与理由（只读，不改变原始提交）
  app.get('/api/adjudications', (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const list = [...adjudications.values()].filter(a => !status || a.status === status);
    res.json(list.map(hydrateAdjudication));
  });

  // 协调定稿：revision 乐观锁防并发覆盖；只写最终结论，不动双方原始提交
  app.put('/api/adjudications/:id', (req, res) => {
    const adj = adjudications.get(req.params.id);
    if (!adj) return res.status(404).json({error: 'not_found'});
    const body = req.body ?? {};
    if (body.revision !== adj.revision) {
      return res.status(409).json({error: 'revision_conflict', current: hydrateAdjudication(adj)});
    }
    const finalSkipped = Boolean(body.finalSkipped);
    const finalGrade = finalSkipped ? null : parseGrade(body.finalGrade);
    if (finalGrade === undefined) return res.status(400).json({error: 'invalid_grade'});
    adj.status = 'resolved';
    adj.source = 'adjudicator';
    adj.finalGrade = finalGrade;
    adj.finalSkipped = finalSkipped;
    adj.note = String(body.note ?? '');
    adj.revision += 1;
    adj.updatedAt = new Date().toISOString();
    res.json(hydrateAdjudication(adj));
  });

  // 语料更新：替换文档内容并提升 revision，旧判断保留但立即失效（不自动套用）
  app.post('/api/corpus/documents/:id/replace', (req, res) => {
    const doc = docOf(req.params.id);
    if (!doc) return res.status(404).json({error: 'not_found'});
    doc.content = String((req.body ?? {}).content ?? '');
    doc.revision += 1;
    doc.updatedAt = new Date().toISOString();
    res.json(doc);
  });

  // 进度只统计当前 revision 的有效判断
  app.get('/api/progress', (_req, res) => {
    let validJudgments = 0;
    let completePairs = 0;
    for (const p of pairs) {
      const rev = docOf(p.docId)!.revision;
      const js = pairJudgments(p.queryId, p.docId, rev).filter(Boolean);
      validJudgments += js.length;
      if (js.length === REVIEWERS.length) completePairs += 1;
    }
    const current = [...adjudications.values()].filter(a => a.corpusRevision === docOf(a.docId)!.revision);
    res.json({
      totalPairs: pairs.length,
      neededJudgments: pairs.length * REVIEWERS.length,
      validJudgments,
      completePairs,
      staleJudgments: judgments.length - validJudgments,
      adjudicationPending: current.filter(a => a.status === 'pending').length,
      adjudicationResolved: current.filter(a => a.status === 'resolved').length,
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
