# Search Relevance Lab

搜索相关性工作台：两位评审独立盲评，分歧由协调视图定案。

## 运行

```bash
npm install
npm run dev    # 前端 http://127.0.0.1:4173，API http://127.0.0.1:4174
npm test       # vitest + supertest 服务端场景测试
npm run build  # 类型检查 + 生产构建
```

## 工作流

- **评审 A / B**：`0-3` 打等级，`S` 跳过，`U` 撤销未提交选择，`↑/↓` 或 `J/K` 移动，`Enter` 批量提交。提交前看不到对方选择；双方都提交后自动公开。
- **协调裁决**：只列出双方不一致（含一方跳过）的对子，展示双方等级与理由；定案只写最终判断，不改原始提交。
- 双方一致（含都跳过）自动定案，无需协调。

## 关键设计

- 判断对象按 `(queryId, docId, corpusRevision)` 锁定；语料中文档被替换后 `corpusRevision` 递增，旧判断保留但不套用、不计入进度，旧 revision 的提交返回 `409 stale_revision`。
- 独立提交与协调定案都使用幂等键：同键重放返回首次结果，不同键重复提交返回 `409 already_submitted` / `already_final`。
- 协调定案带 `expectedRevision` 乐观锁，并发协调者只有一人成功。
- 前端把未提交选择、焦点位置按 `(评审员, 语料 revision)` 存 localStorage，刷新后恢复；断线时提交进入离线队列，恢复联网后按原幂等键自动重放。
