#!/usr/bin/env node
/**
 * 青柠笔记 RAG Demo CLI
 *
 *   rag-demo --index                重建索引
 *   rag-demo "怎么导出报表"          单问题演示
 *   rag-demo --eval 12              抽样评测
 *   rag-demo --eval 100             全量评测
 */
import { getIndex, buildIndex, answer, evaluate, CONFIG } from './src/rag.mjs';

function printTrace(res) {
  const trace = res.trace || [];
  if (!trace.length) return;
  console.log(`\nLLM 调用链（${trace.length} 次，SiliconFlow）：`);
  trace.forEach((t, i) => {
    const u = t.usage || {};
    const tokens = u.total_tokens ?? u.input_tokens;
    const extra = t.inputs ? ` inputs=${t.inputs}` : Array.isArray(t.documents) ? ` docs=${t.documents}` : '';
    const stream = t.stream ? ' stream' : '';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${t.endpoint.padEnd(20)} ${String(t.model).padEnd(34)} ` +
      `${String(t.ms).padStart(5)}ms${extra}${stream}${tokens != null ? ` tokens=${tokens}` : ''}`
    );
  });
  const total = trace.reduce((a, t) => a + t.ms, 0);
  console.log(`  合计 ${(total / 1000).toFixed(1)}s`);
}

function printDemo(question, res, showTrace = false) {
  console.log(`\n问题：${question}`);
  if (res.searchQuery && res.searchQuery !== question) console.log(`检索改写：${res.searchQuery}`);
  console.log('\n答案：');
  console.log(res.text);
  console.log('\n引用：');
  res.top.forEach((c, i) => {
    console.log(`  [${i + 1}] §${c.section} ${c.title}  rerank=${c.rerank.toFixed(4)} sim=${c.sim.toFixed(4)}`);
    console.log(`      ${c.url}`);
  });
  console.log('\n召回证据：');
  res.candidates.slice(0, 5).forEach((c, i) => {
    console.log(`  #${i + 1} §${c.section} ${c.title}  sim=${c.sim.toFixed(4)}`);
  });
  if (showTrace) printTrace(res);
}

function usage() {
  console.log(`青柠笔记 RAG Demo

用法：
  rag-demo --index                重建索引
  rag-demo "怎么导出报表"          单问题演示
  rag-demo "怎么导出报表" --trace  显示每次 SiliconFlow 调用
  rag-demo --eval 12              抽样评测
  rag-demo --eval 100             全量评测

模型（可用环境变量覆盖）：
  EMBED   ${CONFIG.embedModel}
  RERANK  ${CONFIG.rerankModel}
  REWRITE ${CONFIG.rewriteModel}
  CHAT    ${CONFIG.chatModel}`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const showTrace = rawArgs.includes('--trace');
  const args = rawArgs.filter(a => a !== '--trace');
  if (args[0] === '--help' || args[0] === '-h') return usage();
  if (args[0] === '--index') {
    await buildIndex();
    return;
  }

  const idx = await getIndex();
  if (args[0] === '--eval') {
    const n = Number(args[1] || 12);
    if (!Number.isFinite(n) || n < 1) throw new Error('--eval 需要一个正整数');
    await evaluate(n, idx);
    return;
  }

  const question = args.join(' ').trim();
  if (!question) {
    usage();
    process.exit(1);
  }
  printDemo(question, await answer(question, idx), showTrace);
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
