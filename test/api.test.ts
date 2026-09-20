import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

let seq = 0;
function judge(app: ReturnType<typeof createApp>, reviewer: string, pair: {queryId: string; docId: string}, corpusRevision: number, payload: {grade?: number | null; skipped?: boolean; rationale?: string}, key = `k-${++seq}`) {
  return request(app)
    .post('/api/judgments')
    .set('Idempotency-Key', key)
    .send({queryId: pair.queryId, docId: pair.docId, corpusRevision, reviewer, grade: null, skipped: false, rationale: '', ...payload});
}

const P1 = {queryId: 'q1', docId: 'd1'};
const P2 = {queryId: 'q1', docId: 'd2'};
const P3 = {queryId: 'q2', docId: 'd3'};
const P4 = {queryId: 'q2', docId: 'd4'};
const P5 = {queryId: 'q3', docId: 'd5'};
const P6 = {queryId: 'q3', docId: 'd1'};

describe('双方独立评审', () => {
  it('双方等级相同时自动生成最终判断，不进入待协调队列', async () => {
    const app = createApp();
    await judge(app, 'r1', P1, 1, {grade: 2, rationale: '匹配'}).expect(201);
    await judge(app, 'r2', P1, 1, {grade: 2, rationale: '符合'}).expect(201);

    const all = await request(app).get('/api/adjudications').expect(200);
    const adj = all.body.find((a: {queryId: string; docId: string}) => a.queryId === P1.queryId && a.docId === P1.docId);
    expect(adj.status).toBe('resolved');
    expect(adj.source).toBe('agreement');
    expect(adj.finalGrade).toBe(2);

    const progress = await request(app).get('/api/progress').expect(200);
    expect(progress.body.completePairs).toBe(1);
    expect(progress.body.adjudicationPending).toBe(0);
  });

  it('等级不同进入协调队列，协调定稿不改变双方原始提交', async () => {
    const app = createApp();
    await judge(app, 'r1', P2, 1, {grade: 3, rationale: '完全匹配'}).expect(201);
    await judge(app, 'r2', P2, 1, {grade: 1, rationale: '有线耳机不符合'}).expect(201);

    const pending = await request(app).get('/api/adjudications?status=pending').expect(200);
    expect(pending.body).toHaveLength(1);
    const adj = pending.body[0];
    expect(adj.judgments.map((j: {rationale: string}) => j.rationale).sort()).toEqual(['完全匹配', '有线耳机不符合'].sort());

    await request(app).put(`/api/adjudications/${adj.id}`).send({finalGrade: 2, note: '折中', revision: 0}).expect(200);

    const after = await request(app).get('/api/adjudications').expect(200);
    const resolved = after.body.find((a: {id: string}) => a.id === adj.id);
    expect(resolved.finalGrade).toBe(2);
    expect(resolved.source).toBe('adjudicator');
    const grades = Object.fromEntries(resolved.judgments.map((j: {reviewer: string; grade: number}) => [j.reviewer, j.grade]));
    expect(grades).toEqual({r1: 3, r2: 1}); // 原始提交未被协调改动
  });

  it('一方跳过视为分歧，进入协调队列', async () => {
    const app = createApp();
    await judge(app, 'r1', P3, 1, {skipped: true, rationale: '无法判断'}).expect(201);
    await judge(app, 'r2', P3, 1, {grade: 3}).expect(201);

    const pending = await request(app).get('/api/adjudications?status=pending').expect(200);
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0].judgments.find((j: {reviewer: string}) => j.reviewer === 'r1').skipped).toBe(true);
  });

  it('提交前看不到对方选择，提交后仅可见对方已提交标记', async () => {
    const app = createApp();
    await judge(app, 'r1', P6, 1, {grade: 0, rationale: 'secret-rationale'}).expect(201);

    const other = await request(app).get('/api/tasks?reviewer=r2').expect(200);
    const taskForOther = other.body.find((t: {docId: string; queryId: string}) => t.docId === P6.docId && t.queryId === P6.queryId);
    expect(JSON.stringify(taskForOther)).not.toContain('secret-rationale');
    expect(taskForOther.partnerSubmitted).toBe(false); // 自己未提交前无任何对方信息

    const mine = await request(app).get('/api/tasks?reviewer=r1').expect(200);
    const taskForMe = mine.body.find((t: {docId: string; queryId: string}) => t.docId === P6.docId && t.queryId === P6.queryId);
    expect(taskForMe.myJudgment.grade).toBe(0);
    expect(taskForMe.partnerSubmitted).toBe(false); // 对方尚未提交
  });
});

describe('幂等与重复提交', () => {
  it('同一幂等键重复提交返回首次结果且不重复计数', async () => {
    const app = createApp();
    const first = await judge(app, 'r1', P4, 1, {grade: 1}, 'dup-key').expect(201);
    const replay = await judge(app, 'r1', P4, 1, {grade: 1}, 'dup-key').expect(200);
    expect(replay.body.deduplicated).toBe(true);
    expect(replay.body.judgment.id).toBe(first.body.judgment.id);

    const progress = await request(app).get('/api/progress').expect(200);
    expect(progress.body.validJudgments).toBe(1);
  });

  it('同一幂等键携带不同内容返回 409', async () => {
    const app = createApp();
    await judge(app, 'r1', P4, 1, {grade: 1}, 'dup-key').expect(201);
    const res = await judge(app, 'r1', P4, 1, {grade: 3}, 'dup-key').expect(409);
    expect(res.body.error).toBe('idempotency_mismatch');
  });

  it('同一判断对象用不同键重复提交返回 409', async () => {
    const app = createApp();
    await judge(app, 'r1', P4, 1, {grade: 1}).expect(201);
    const res = await judge(app, 'r1', P4, 1, {grade: 2}).expect(409);
    expect(res.body.error).toBe('already_submitted');
  });
});

describe('语料更新', () => {
  it('文档替换后旧判断失效、不套用新内容，旧 revision 提交被拒绝', async () => {
    const app = createApp();
    await judge(app, 'r1', P4, 1, {grade: 0, rationale: '不防水'}).expect(201);
    await judge(app, 'r2', P4, 1, {grade: 1}).expect(201);

    const replaced = await request(app).post('/api/corpus/documents/d4/replace').send({content: 'v2 content'}).expect(200);
    expect(replaced.body.revision).toBe(2);

    // 旧判断不再计入进度
    const progress = await request(app).get('/api/progress').expect(200);
    expect(progress.body.validJudgments).toBe(0);
    expect(progress.body.staleJudgments).toBe(2);

    // 旧 revision 的提交被拒绝
    const stale = await judge(app, 'r1', P4, 1, {grade: 2}).expect(409);
    expect(stale.body.error).toBe('stale_revision');
    expect(stale.body.currentRevision).toBe(2);

    // 新 revision 是全新判断对象，不继承旧等级
    const tasks = await request(app).get('/api/tasks?reviewer=r1').expect(200);
    const task = tasks.body.find((t: {docId: string; queryId: string}) => t.docId === P4.docId && t.queryId === P4.queryId);
    expect(task.corpusRevision).toBe(2);
    expect(task.myJudgment).toBeNull();

    await judge(app, 'r1', P4, 2, {grade: 2}).expect(201);
    const after = await request(app).get('/api/progress').expect(200);
    expect(after.body.validJudgments).toBe(1);
  });

  it('进度只统计当前 revision 的有效判断', async () => {
    const app = createApp();
    await judge(app, 'r1', P5, 1, {grade: 3}).expect(201);
    let progress = await request(app).get('/api/progress').expect(200);
    expect(progress.body.validJudgments).toBe(1);

    await request(app).post('/api/corpus/documents/d5/replace').send({content: 'v2'}).expect(200);
    progress = await request(app).get('/api/progress').expect(200);
    expect(progress.body.validJudgments).toBe(0);
    expect(progress.body.staleJudgments).toBe(1);
  });
});

describe('协调者并发编辑', () => {
  it('基于同一 revision 的两次定稿，第二次返回 409', async () => {
    const app = createApp();
    await judge(app, 'r1', P5, 1, {grade: 3}).expect(201);
    await judge(app, 'r2', P5, 1, {grade: 0}).expect(201);
    const pending = await request(app).get('/api/adjudications?status=pending').expect(200);
    const adj = pending.body[0];

    await request(app).put(`/api/adjudications/${adj.id}`).send({finalGrade: 2, note: '第一位协调者', revision: 0}).expect(200);
    const conflict = await request(app).put(`/api/adjudications/${adj.id}`).send({finalGrade: 1, note: '第二位协调者', revision: 0}).expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
    expect(conflict.body.current.finalGrade).toBe(2); // 先提交者胜出，响应携带最新状态
  });
});
