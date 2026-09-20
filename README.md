# Search Relevance Lab

搜索相关性评审工作台：两位评审独立打等级（互不可见），分歧由协调视图定稿。

## 运行

```bash
npm install
npm run dev      # 前端 :4173，API :4174
npm test         # 服务端场景测试
npm run build    # 类型检查 + 构建
```

## 流程

1. **评审**：在「评审」视图选择身份（r1 / r2），对每个 查询×文档 打等级（无关/勉强/相关/完美）或跳过。提交前看不到对方任何信息；提交后判断锁定，仅能看到对方"已提交"标记。
2. **协调**：双方都提交后，等级一致自动定稿；分歧（含一方跳过）进入「协调」视图。协调视图展示双方等级与理由（只读），协调者给出最终等级与说明，不改动原始提交。
3. **进度**：顶栏只统计当前语料 revision 的有效判断；文档被替换后旧判断立即失效、不计入进度。

## 评审快捷键

| 键 | 作用 |
| --- | --- |
| `0`–`3` | 打等级并跳下一条 |
| `s` | 跳过 |
| `u` | 撤销最近一条未提交选择 |
| `Enter` | 批量提交所有未提交选择 |
| `j`/`k` 或方向键 | 移动焦点 |

未提交的选择与焦点位置保存在 localStorage，刷新页面后恢复；断线时保留在本地，网络恢复后自动重发（每条选择携带幂等键，重发安全）。

## API 摘要

- `GET /api/tasks?reviewer=r1|r2` — 当前 revision 的任务列表，只含本人的判断
- `POST /api/judgments` — 提交判断，按 `(queryId, docId, corpusRevision)` 锁定对象；需 `Idempotency-Key` 头，重复提交返回首次结果；revision 过期返回 `409 stale_revision`
- `GET /api/adjudications?status=pending` — 协调单（含双方等级与理由）
- `PUT /api/adjudications/:id` — 协调定稿，`revision` 乐观锁防并发覆盖（冲突返回 `409 revision_conflict` 及最新状态）
- `POST /api/corpus/documents/:id/replace` — 替换文档内容并提升语料 revision
- `GET /api/progress` — 进度（仅统计当前 revision 的有效判断）
