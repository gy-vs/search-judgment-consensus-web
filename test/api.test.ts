import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

let seq = 0;
const key = () => `key-${++seq}`;

function judge(app: ReturnType<typeof createApp>, over: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/judgments')
    .send({queryId: 'q1', docId: 'd1', corpusRevision: 1, reviewer: 'A', grade: 2, rationale: '', idempotencyKey: key(), ...over});
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function pairOf(body: {items: Array<{pair: any}>}, queryId = 'q1', docId = 'd1'): any {
  const item = body.items.find(i => i.pair.queryId === queryId && i.pair.docId === docId);
  if (!item) throw new Error(`pair ${queryId}/${docId} not found`);
  return item.pair;
}

describe('双评审盲评与协调裁决', () => {
  it('双方等级一致时自动定案并计入进度', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 2, rationale: '相关'}).expect(201);
    const res = await judge(app, {reviewer: 'B', grade: 2, rationale: '同意'}).expect(201);

    expect(res.body.pair.status).toBe('final');
    expect(res.body.pair.final).toMatchObject({grade: 2, source: 'consensus'});

    const progress = (await request(app).get('/api/progress').expect(200)).body;
    expect(progress).toMatchObject({corpusRevision: 1, final: 1, adjudication: 0, total: 12});
  });

  it('等级不同进入协调队列，协调定案且不改动原始提交', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 3, rationale: '高度相关'}).expect(201);
    const res = await judge(app, {reviewer: 'B', grade: 1, rationale: '勉强相关'}).expect(201);
    expect(res.body.pair.status).toBe('adjudication');
    expect(res.body.pair.final).toBeNull();

    const queue = (await request(app).get('/api/adjudications').expect(200)).body;
    expect(queue.items).toHaveLength(1);
    const item = queue.items[0];
    // 协调视图能看到双方等级与理由
    expect(item.pair.submissions.A).toMatchObject({grade: 3, rationale: '高度相关'});
    expect(item.pair.submissions.B).toMatchObject({grade: 1, rationale: '勉强相关'});

    const decided = await request(app)
      .post(`/api/adjudications/${item.pair.id}/decide`)
      .send({finalGrade: 2, note: '折中定 2', adjudicator: 'coord', expectedRevision: item.pair.revision, idempotencyKey: key()})
      .expect(200);
    expect(decided.body.pair.status).toBe('final');
    expect(decided.body.pair.final).toMatchObject({grade: 2, source: 'adjudicator', note: '折中定 2', by: 'coord'});
    // 协调不改写双方原始提交
    expect(decided.body.pair.submissions.A.grade).toBe(3);
    expect(decided.body.pair.submissions.B.grade).toBe(1);

    const after = (await request(app).get('/api/adjudications').expect(200)).body;
    expect(after.items).toHaveLength(0);
    const progress = (await request(app).get('/api/progress').expect(200)).body;
    expect(progress).toMatchObject({final: 1, adjudication: 0});
  });

  it('一方跳过仍需协调，双方跳过自动定案为跳过', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: null, rationale: '无法判断'}).expect(201);
    const mixed = await judge(app, {reviewer: 'B', grade: 2}).expect(201);
    expect(mixed.body.pair.status).toBe('adjudication');

    const other = {queryId: 'q2', docId: 'd2'};
    await judge(app, {...other, reviewer: 'A', grade: null}).expect(201);
    const both = await judge(app, {...other, reviewer: 'B', grade: null}).expect(201);
    expect(both.body.pair.status).toBe('final');
    expect(both.body.pair.final).toMatchObject({grade: null, source: 'both_skipped'});
  });

  it('重复提交：同幂等键幂等返回，不同键拒绝', async () => {
    const app = createApp();
    const first = await judge(app, {reviewer: 'A', grade: 1, idempotencyKey: 'dup-key'}).expect(201);

    const replay = await judge(app, {reviewer: 'A', grade: 1, idempotencyKey: 'dup-key'}).expect(200);
    expect(replay.body.deduplicated).toBe(true);
    expect(replay.body.pair.revision).toBe(first.body.pair.revision);
    expect(replay.body.pair.mine.grade).toBe(1);

    const conflict = await judge(app, {reviewer: 'A', grade: 3, idempotencyKey: 'another-key'}).expect(409);
    expect(conflict.body.error).toBe('already_submitted');
    // 原提交未被覆盖
    expect(conflict.body.pair.mine.grade).toBe(1);
  });

  it('语料更新后旧判断不套用，旧 revision 提交被拒绝，进度只统计当前 revision', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 2}).expect(201);
    await judge(app, {reviewer: 'B', grade: 2}).expect(201);
    expect((await request(app).get('/api/progress')).body.final).toBe(1);

    const replaced = await request(app)
      .post('/api/corpus/documents/d1/replace')
      .send({content: '替换后的全新内容'})
      .expect(200);
    expect(replaced.body.corpusRevision).toBe(2);

    // 旧 revision 的提交被拒绝
    const stale = await judge(app, {queryId: 'q2', docId: 'd1', reviewer: 'A', corpusRevision: 1}).expect(409);
    expect(stale.body).toMatchObject({error: 'stale_revision', currentRevision: 2});

    // 进度只统计当前 revision：旧定案不计入
    const progress = (await request(app).get('/api/progress').expect(200)).body;
    expect(progress).toMatchObject({corpusRevision: 2, final: 0, adjudication: 0, total: 12});

    // 新 revision 是全新对子，旧判断不可见、不套用
    const board = (await request(app).get('/api/judgments?reviewer=A').expect(200)).body;
    expect(board.corpusRevision).toBe(2);
    const pair = pairOf(board);
    expect(pair).toMatchObject({corpusRevision: 2, status: 'pending', mine: null});

    // 新 revision 可以正常重新判断
    await judge(app, {reviewer: 'A', grade: 0, corpusRevision: 2}).expect(201);
    const again = await judge(app, {reviewer: 'B', grade: 0, corpusRevision: 2}).expect(201);
    expect(again.body.pair.final).toMatchObject({grade: 0, source: 'consensus'});
  });

  it('协调者并发编辑：只有一个定案成功，过期 revision 冲突，幂等重放安全', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 3}).expect(201);
    await judge(app, {reviewer: 'B', grade: 0}).expect(201);
    const item = (await request(app).get('/api/adjudications')).body.items[0];
    const url = `/api/adjudications/${item.pair.id}/decide`;

    // 过期 revision → 冲突
    const stale = await request(app)
      .post(url)
      .send({finalGrade: 1, note: '', adjudicator: 'c2', expectedRevision: item.pair.revision + 9, idempotencyKey: key()})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');

    // 第一个协调者定案成功
    await request(app)
      .post(url)
      .send({finalGrade: 1, note: 'c1 定案', adjudicator: 'c1', expectedRevision: item.pair.revision, idempotencyKey: 'decide-1'})
      .expect(200);

    // 并发的第二个协调者失败，原定案不变
    const loser = await request(app)
      .post(url)
      .send({finalGrade: 3, note: 'c2 定案', adjudicator: 'c2', expectedRevision: item.pair.revision, idempotencyKey: 'decide-2'})
      .expect(409);
    expect(loser.body.error).toBe('already_final');
    expect(loser.body.pair.final).toMatchObject({grade: 1, by: 'c1'});

    // 断线重试：同幂等键重放返回原结果
    const replay = await request(app)
      .post(url)
      .send({finalGrade: 1, note: 'c1 定案', adjudicator: 'c1', expectedRevision: item.pair.revision, idempotencyKey: 'decide-1'})
      .expect(200);
    expect(replay.body.deduplicated).toBe(true);
    expect(replay.body.pair.final.grade).toBe(1);
  });

  it('未产生分歧时不能协调定案', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 2}).expect(201);
    const res = await request(app)
      .post('/api/adjudications/q1:d1:1/decide')
      .send({finalGrade: 2, note: '', adjudicator: 'c', expectedRevision: 1, idempotencyKey: key()})
      .expect(409);
    expect(res.body.error).toBe('not_ready');
  });

  it('盲评隔离：对方提交前看不到其选择，双方提交后才公开', async () => {
    const app = createApp();
    await judge(app, {reviewer: 'A', grade: 3, rationale: '理由A'}).expect(201);

    const boardB = (await request(app).get('/api/judgments?reviewer=B').expect(200)).body;
    const forB = pairOf(boardB);
    expect(forB.mine).toBeNull();
    expect(forB.other).toEqual({submitted: true});
    expect(JSON.stringify(forB.other)).not.toContain('理由A');

    const boardA = (await request(app).get('/api/judgments?reviewer=A').expect(200)).body;
    expect(pairOf(boardA).other).toEqual({submitted: false});

    await judge(app, {reviewer: 'B', grade: 1, rationale: '理由B'}).expect(201);
    const revealed = pairOf((await request(app).get('/api/judgments?reviewer=B').expect(200)).body);
    expect(revealed.other.submission).toMatchObject({grade: 3, rationale: '理由A'});
  });
});
