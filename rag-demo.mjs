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

function printDemo(question, res) {
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
}

function usage() {
  console.log(`青柠笔记 RAG Demo

用法：
  rag-demo --index                重建索引
  rag-demo "怎么导出报表"          单问题演示
  rag-demo --eval 12              抽样评测
  rag-demo --eval 100             全量评测

模型（可用环境变量覆盖）：
  EMBED   ${CONFIG.embedModel}
  RERANK  ${CONFIG.rerankModel}
  REWRITE ${CONFIG.rewriteModel}
  CHAT    ${CONFIG.chatModel}`);
}

async function main() {
  const args = process.argv.slice(2);
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
  printDemo(question, await answer(question, idx));
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
