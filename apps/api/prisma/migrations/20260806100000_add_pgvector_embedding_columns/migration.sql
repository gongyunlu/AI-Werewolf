-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- Memory.embedding：Agent 长期记忆的语义向量，维度对齐火山方舟 doubao-embedding-text-240715 (2560)。
-- 不建 HNSW/IVFFlat 索引：pgvector 单精度索引维度上限 2000，2560 只能顺序扫描。
ALTER TABLE "memories" ADD COLUMN "embedding" vector(2560);

-- GlobalMemory.embedding：跨对局共享记忆的语义向量，口径同上。
ALTER TABLE "global_memories" ADD COLUMN "embedding" vector(2560);
