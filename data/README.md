# 模拟帮助中心数据包（RAG 评测用）

这是一套**完全虚构**的产品帮助中心与评测问题集，用于验证站内搜索 / 帮助文档 RAG 的端到端效果。所有产品名、价格、额度、联系方式均为模拟值，不对应任何真实产品。

## 文件

| 文件 | 说明 |
|---|---|
| `help-center.pdf` | 帮助中心全文，A4，20 页，10 章 54 节 |
| `help-center.html` | PDF 源文件，改内容后可用 Chrome 重新打印 |
| `eval-questions-100.csv` | 100 条评测问题 + 标准答案 + 文档出处 |
| `documents.csv` | 54 个小节的元数据（标题、章节、URL、版本），供切片与引用使用 |

## 文档内容

模拟产品「青柠笔记」v3.0，覆盖 10 章：

1. 账号与登录（注册、登录、找回、改绑、注销）
2. 发布笔记（类型、流程、草稿、定时、审核）
3. 搜索与发现（范围、筛选、技巧、无结果）
4. 会员与订阅（权益、价格、自动续费、发票、退款）
5. 报表中心（类型、筛选、导出、定时、乱码、口径）
6. 团队与权限（角色矩阵、邀请、转移、归属）
7. 数据与备份（回收站、恢复、导出、同步）
8. 常见故障（上传、冲突、乱码、白屏、支付、通知）
9. 版本差异（v2.8 → v3.0）
10. 不支持与转人工（边界、客服、紧急、投诉）

## 评测集说明

`eval-questions-100.csv` 共 100 行，列定义：

| 列 | 含义 |
|---|---|
| `id` | 问题编号 |
| `question` | 用户原始问法（含口语、错别字） |
| `type` | howto / feature / troubleshoot / colloquial / version / out_of_scope / handoff |
| `expected_answer` | 标准答案（用于人工对照或 LLM-as-judge） |
| `source_section` | 正确出处，如 `§5.3`；`无` 表示文档未覆盖 |
| `should_abstain` | 1 = 应当回答“没找到”，不得编造 |
| `should_handoff` | 1 = 应转人工，不得承诺结果 |
| `difficulty` | easy / medium / high |
| `notes` | 该题的考察点 |

### 分布

| 类型 | 数量 | 设计意图 |
|---|---|---|
| howto | 21 | 常规操作路径 |
| troubleshoot | 20 | 故障排查，考多条件组合 |
| feature | 19 | 参数、权益、权限矩阵 |
| colloquial | 20 | 口语、方言、错别字（如“小书”→“笔记”），考容错召回 |
| version | 5 | v2.8 与 v3.0 差异，考版本隔离 |
| out_of_scope | 10 | 文档未覆盖，考拒答与不臆测 |
| handoff | 5 | 退款、合同、盗号、投诉、泄露，考转人工 |

其中 `should_abstain=1` 共 10 条，`should_handoff=1` 共 6 条。

## 建议用法

1. **建索引**：按 `documents.csv` 的 `section_id` 切片，chunk 元数据带上 `section_number`、`title`、`url`、`product_version`。
2. **跑检索**：对每题取 top-k，判断 `source_section` 是否命中；口语题单独统计命中率。
3. **跑生成**：用 `expected_answer` 做人工对照，或用 LLM-as-judge 评 faithfulness / correctness。
4. **跑边界**：`should_abstain=1` 的题必须回答“未找到”；`should_handoff=1` 的题必须给转人工入口。这两项单独算准确率。

### 建议指标

- 检索：Recall@5、MRR、错别字题 Recall@5
- 回答：答案正确率、引用命中率、faithfulness
- 边界：拒答准确率、转人工准确率、越权承诺率（应为 0）
- 体验：一次解决率、平均检索次数、无答案率

## 重新生成 PDF

修改 `help-center.html` 后：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/chrome-rag-pdf --no-pdf-header-footer \
  --print-to-pdf=help-center.pdf \
  file:///absolute/path/to/help-center.html
```

## 注意

- 文档中的价格、额度、客服电话、邮箱均为虚构，仅用于测试。
- 评测集故意包含 10 条文档未覆盖的问题，**答出来反而是错的**。
- 口语题（第 61–80 条）是这套数据的重点：精确匹配搜索在这里会明显掉分。
