import express from 'express';
import {fileURLToPath} from 'node:url';

export type Grade = 0 | 1 | 2 | 3;
export type Side = 'A' | 'B';
export type PairStatus = 'pending' | 'awaiting' | 'adjudication' | 'final';

export interface Submission {
  grade: Grade | null; // null 表示跳过
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
  idempotencyKey: string | null;
}

// 判断对象由 (queryId, docId, corpusRevision) 三元组锁定：
// 语料中文档被替换后 corpusRevision 递增，旧判断保留在原位但不会套用到新内容。
export interface Pair {
  id: string;
  queryId: string;
  docId: string;
  corpusRevision: number;
  submissions: Partial<Record<Side, Submission>>;
  status: PairStatus;
  final: FinalDecision | null;
  revision: number; // 每次状态变化自增，协调者用它做乐观并发控制
}

interface QueryRow {id: string; text: string}
interface DocRow {id: string; title: string; content: string; version: number}

const GRADES: Grade[] = [0, 1, 2, 3];

function isGradeOrSkip(value: unknown): value is Grade | null {
  return value === null || (typeof value === 'number' && GRADES.includes(value as Grade));
}

function pairIdOf(queryId: string, docId: string, corpusRevision: number) {
  return `${queryId}:${docId}:${corpusRevision}`;
}

export function createApp() {
  const queries: QueryRow[] = [
    {id: 'q1', text: '无线鼠标 续航'},
    {id: 'q2', text: '降噪耳机 地铁通勤'},
    {id: 'q3', text: '保温杯 316不锈钢'},
  ];
  const docs: DocRow[] = [
    {id: 'd1', title: '静音无线鼠标', content: '2.4G 无线鼠标，官方标称续航 18 个月。', version: 1},
    {id: 'd2', title: '头戴式降噪耳机', content: '主动降噪，通勤场景低频降噪明显。', version: 1},
    {id: 'd3', title: '不锈钢保温杯', content: '316 不锈钢内胆，保温 12 小时。', version: 1},
    {id: 'd4', title: '机械键盘', content: '有线机械键盘，热插拔轴体。', version: 1},
  ];
  let corpusRevision = 1;
  const pairs = new Map<string, Pair>();

  const findQuery = (id: string) => queries.find(q => q.id === id);
  const findDoc = (id: string) => docs.find(d => d.id === id);

  function getOrCreatePair(queryId: string, docId: string): Pair {
    const id = pairIdOf(queryId, docId, corpusRevision);
    let pair = pairs.get(id);
    if (!pair) {
      pair = {id, queryId, docId, corpusRevision, submissions: {}, status: 'pending', final: null, revision: 0};
      pairs.set(id, pair);
    }
    return pair;
  }

  // 列表里尚未产生任何提交的对子不落库，返回一个虚拟 pending 视图
  function virtualPair(queryId: string, docId: string): Pair {
    return {id: pairIdOf(queryId, docId, corpusRevision), queryId, docId, corpusRevision, submissions: {}, status: 'pending', final: null, revision: 0};
  }

  function settle(pair: Pair) {
    const a = pair.submissions.A;
    const b = pair.submissions.B;
    if (!a || !b) {
      pair.status = 'awaiting';
      return;
    }
    if (a.grade === b.grade) {
      pair.status = 'final';
      pair.final = {
        grade: a.grade,
        source: a.grade === null ? 'both_skipped' : 'consensus',
        note: '',
        by: null,
        decidedAt: new Date().toISOString(),
        idempotencyKey: null,
      };
    } else {
      pair.status = 'adjudication';
    }
  }

  // 盲评视图：对方未提交时只暴露 submitted 标志；双方都提交后才公开对方选择
  function reviewerView(pair: Pair, side: Side) {
    const otherSide: Side = side === 'A' ? 'B' : 'A';
    const other = pair.submissions[otherSide];
    const bothIn = Boolean(pair.submissions.A && pair.submissions.B);
    return {
      id: pair.id,
      queryId: pair.queryId,
      docId: pair.docId,
      corpusRevision: pair.corpusRevision,
      status: pair.status,
      revision: pair.revision,
      mine: pair.submissions[side] ?? null,
      other: other ? (bothIn ? {submitted: true, submission: other} : {submitted: true}) : {submitted: false},
      final: pair.final,
    };
  }

  // 协调视图：展示双方原始提交，定案只写 final，从不动 submissions
  function adjudicatorView(pair: Pair) {
    return {
      id: pair.id,
      queryId: pair.queryId,
      docId: pair.docId,
      corpusRevision: pair.corpusRevision,
      status: pair.status,
      revision: pair.revision,
      submissions: pair.submissions,
      final: pair.final,
    };
  }

  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => {
    res.json({family: 'search-relevance', corpusRevision, queries, docs});
  });

  app.get('/api/judgments', (req, res) => {
    const reviewer = req.query.reviewer;
    if (reviewer !== 'A' && reviewer !== 'B') return res.status(400).json({error: 'invalid_reviewer'});
    const items = [];
    for (const query of queries) {
      for (const doc of docs) {
        const pair = pairs.get(pairIdOf(query.id, doc.id, corpusRevision)) ?? virtualPair(query.id, doc.id);
        items.push({pair: reviewerView(pair, reviewer), query, doc});
      }
    }
    res.json({corpusRevision, items});
  });

  app.post('/api/judgments', (req, res) => {
    const {queryId, docId, corpusRevision: rev, reviewer, grade, rationale, idempotencyKey} = req.body ?? {};
    if (!findQuery(String(queryId)) || !findDoc(String(docId))) return res.status(404).json({error: 'not_found'});
    if (reviewer !== 'A' && reviewer !== 'B') return res.status(400).json({error: 'invalid_reviewer'});
    if (!isGradeOrSkip(grade)) return res.status(400).json({error: 'invalid_grade'});
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return res.status(400).json({error: 'missing_idempotency_key'});
    if (rev !== corpusRevision) return res.status(409).json({error: 'stale_revision', currentRevision: corpusRevision});

    const pair = getOrCreatePair(String(queryId), String(docId));
    const existing = pair.submissions[reviewer as Side];
    if (existing) {
      // 同一幂等键重放返回首次结果；不同键视为重复提交，拒绝
      if (existing.idempotencyKey === idempotencyKey) {
        return res.status(200).json({pair: reviewerView(pair, reviewer), deduplicated: true});
      }
      return res.status(409).json({error: 'already_submitted', pair: reviewerView(pair, reviewer)});
    }

    pair.submissions[reviewer as Side] = {
      grade,
      rationale: String(rationale ?? ''),
      idempotencyKey,
      submittedAt: new Date().toISOString(),
    };
    settle(pair);
    pair.revision += 1;
    res.status(201).json({pair: reviewerView(pair, reviewer)});
  });

  app.get('/api/adjudications', (_req, res) => {
    const items = [...pairs.values()]
      .filter(pair => pair.corpusRevision === corpusRevision && pair.status === 'adjudication')
      .map(pair => ({pair: adjudicatorView(pair), query: findQuery(pair.queryId), doc: findDoc(pair.docId)}));
    res.json({corpusRevision, items});
  });

  app.post('/api/adjudications/:pairId/decide', (req, res) => {
    const pair = pairs.get(req.params.pairId);
    if (!pair) return res.status(404).json({error: 'not_found'});
    const {finalGrade, note, adjudicator, expectedRevision, idempotencyKey} = req.body ?? {};
    if (!isGradeOrSkip(finalGrade)) return res.status(400).json({error: 'invalid_grade'});
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) return res.status(400).json({error: 'missing_idempotency_key'});

    if (pair.final) {
      // 已定案：同键重放幂等返回，否则说明有并发协调者抢先定案
      if (pair.final.idempotencyKey === idempotencyKey) {
        return res.status(200).json({pair: adjudicatorView(pair), deduplicated: true});
      }
      return res.status(409).json({error: 'already_final', pair: adjudicatorView(pair)});
    }
    if (pair.status !== 'adjudication') return res.status(409).json({error: 'not_ready', status: pair.status});
    if (expectedRevision !== pair.revision) {
      return res.status(409).json({error: 'revision_conflict', pair: adjudicatorView(pair)});
    }

    pair.final = {
      grade: finalGrade,
      source: 'adjudicator',
      note: String(note ?? ''),
      by: String(adjudicator ?? 'coordinator'),
      decidedAt: new Date().toISOString(),
      idempotencyKey,
    };
    pair.status = 'final';
    pair.revision += 1;
    res.status(200).json({pair: adjudicatorView(pair)});
  });

  app.get('/api/progress', (_req, res) => {
    // 进度只统计当前 revision 的对子，旧 revision 的判断一律不计入
    const current = [...pairs.values()].filter(pair => pair.corpusRevision === corpusRevision);
    const count = (status: PairStatus) => current.filter(pair => pair.status === status).length;
    const total = queries.length * docs.length;
    res.json({
      corpusRevision,
      total,
      final: count('final'),
      adjudication: count('adjudication'),
      awaiting: count('awaiting'),
      pending: total - count('final') - count('adjudication') - count('awaiting'),
    });
  });

  // 模拟语料更新：文档内容被替换，corpusRevision 递增，旧判断留在旧 revision 上
  app.post('/api/corpus/documents/:docId/replace', (req, res) => {
    const doc = findDoc(req.params.docId);
    if (!doc) return res.status(404).json({error: 'not_found'});
    doc.content = String(req.body?.content ?? doc.content);
    doc.version += 1;
    corpusRevision += 1;
    res.json({doc, corpusRevision});
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
