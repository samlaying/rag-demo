import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndex, answer, CONFIG } from '../src/rag.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const QUESTIONS = [
  '怎么把报表导出成 Excel',
  '小书怎么发',
  '会员咋退订',
  '收益数据怎么导出',
  '我要退款',
  '明天天气怎么样'
];

const idx = await getIndex();
const items = [];

for (const question of QUESTIONS) {
  const started = Date.now();
  const r = await answer(question, idx);
  items.push({
    question,
    rewritten: r.searchQuery,
    answer: r.text,
    citations: r.top.map((c, i) => ({
      n: i + 1,
      section: c.section,
      title: c.title,
      url: c.url,
      rerank: c.rerank,
      sim: c.sim
    })),
    elapsedMs: Date.now() - started
  });
  console.log(`[demo-data] ${question} (${Date.now() - started}ms)`);
}

const out = path.join(ROOT, 'web', 'demo-data.json');
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  models: {
    embed: CONFIG.embedModel,
    rerank: CONFIG.rerankModel,
    chat: CONFIG.chatModel
  },
  items
}, null, 2) + '\n');

console.log(`[demo-data] written ${out} (${items.length} items)`);
