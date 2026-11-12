import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');

export const CONFIG = {
  base: 'https://api.siliconflow.cn/v1',
  embedModel: 'Qwen/Qwen3-VL-Embedding-8B',
  rerankModel: 'BAAI/bge-reranker-v2-m3',
  rewriteModel: process.env.REWRITE_MODEL || 'Qwen/Qwen2.5-7B-Instruct',
  chatModel: process.env.CHAT_MODEL || 'deepseek-ai/DeepSeek-V3.2',
  topRecall: 12,
  topRerank: 5,
  batch: 16
};

const SYSTEM_PROMPT = `你是「青柠笔记」帮助中心的问答助手。严格按以下规则回答：
1. 只使用【资料】中的信息，不使用任何外部知识。
2. 用户问题可能含错别字、别名或口语，请结合【检索改写】理解真实意图。
3. 先给一句结论，再给不超过 4 步的操作步骤；关键事实后用 [编号] 标注来源。
4. 如果【资料】中没有答案，只输出“未找到相关内容，建议转人工客服”，不要猜测或补充。
5. 涉及退款、合同、账号找回、账号被盗、法律、数据泄露时，不做任何承诺，直接说明需转人工客服。
6. 与产品无关的问题，只输出“未找到相关内容”。
7. 不要输出资料之外的链接、电话或承诺。`;

function loadEnv() {
  if (process.env.SILICONFLOW_API_KEY) return process.env.SILICONFLOW_API_KEY;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .find(l => l.trim().startsWith('SILICONFLOW_API_KEY='));
    if (line) return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('未找到 SILICONFLOW_API_KEY（环境变量或 .env）');
}

const KEY = loadEnv();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathname, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await fetch(CONFIG.base + pathname, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      text = await res.text();
    } catch (err) {
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`${pathname} 网络错误: ${err.message}`);
    }
    if (res.ok) return JSON.parse(text);
    if (attempt < retries && (res.status === 429 || res.status >= 500)) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<tr[^>]*>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h3|table|ul|ol|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, max = 900, overlap = 120) {
  if (text.length <= max) return [text];
  const parts = text.split(/\n+/).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if (buf && buf.length + p.length + 1 > max) {
      chunks.push(buf);
      buf = buf.slice(Math.max(0, buf.length - overlap)) + '\n' + p;
    } else {
      buf = buf ? buf + '\n' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function parseSections() {
  const html = fs.readFileSync(path.join(DATA_DIR, 'help-center.html'), 'utf8');
  const chapters = {};
  for (const m of html.matchAll(/<h1>(\d+)　([^<]+)<\/h1>/g)) chapters[m[1]] = m[2].trim();

  const chunks = [];
  const re = /<h2 id="s(\d+)-(\d+)">([^<]+)<\/h2>([\s\S]*?)(?=<h2 id="s|<\/section>|<h1>)/g;
  for (const m of html.matchAll(re)) {
    const ch = m[1], sec = m[2], title = m[3].trim().replace(/^\d+\.\d+\s*/, '');
    const section = `${ch}.${sec}`;
    const chapter = chapters[ch] || '';
    const header = `§${section} ${title}（第${ch}章 ${chapter}）`;
    const body = htmlToText(m[4]);
    for (const part of chunkText(`${header}\n${body}`)) {
      chunks.push({
        section,
        title,
        chapter,
        url: `https://help.qingning.example/v3/#s${ch}-${sec}`,
        text: part
      });
    }
  }
  if (chunks.length < 40) throw new Error(`切片数量异常: ${chunks.length}`);
  return { html, chunks };
}

const sourceHash = html => crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

export async function buildIndex(log = console.error) {
  const { html, chunks } = parseSections();
  const hash = sourceHash(html);
  const vectors = [];
  log(`[index] 切片 ${chunks.length} 个，开始 embedding...`);
  for (let i = 0; i < chunks.length; i += CONFIG.batch) {
    const batch = chunks.slice(i, i + CONFIG.batch);
    const r = await api('/embeddings', {
      model: CONFIG.embedModel,
      input: batch.map(c => c.text)
    });
    // 该接口单批超过 8 条时 index 会每 8 条重置（0-7, 0-7），
    // 不能按 index 排序；响应顺序与输入顺序一致，直接按顺序对齐。
    if (r.data.length !== batch.length) {
      throw new Error(`embedding 返回数量不匹配: ${r.data.length} != ${batch.length}`);
    }
    for (const d of r.data) vectors.push(d.embedding);
    log(`[index] ${Math.min(i + CONFIG.batch, chunks.length)}/${chunks.length}`);
    await sleep(120);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const payload = { hash, model: CONFIG.embedModel, dim: vectors[0].length, chunks, vectors };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(payload));
  log(`[index] 完成，dim=${payload.dim}，缓存 ${INDEX_FILE}`);
  return payload;
}

export async function getIndex() {
  if (fs.existsSync(INDEX_FILE)) {
    const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    const html = fs.readFileSync(path.join(DATA_DIR, 'help-center.html'), 'utf8');
    if (idx.hash === sourceHash(html) && idx.model === CONFIG.embedModel) return idx;
  }
  return buildIndex();
}

async function rewriteQuery(question) {
  try {
    const clean = question.replace(/[“”"]/g, '').trim();
    const r = await api('/chat/completions', {
      model: CONFIG.rewriteModel,
      temperature: 0,
      max_tokens: 80,
      messages: [
        { role: 'system', content: '你是青柠笔记（内容社区与创作工具）帮助中心的搜索查询改写器。用户可能打错字、使用别名或口语，例如把“笔记”写成“小书”“笔几”。把用户问题改写成 1 条适合检索帮助文档的中文查询：保留原问题的对象（如报表、会员、团队、发票），只纠正明显错别字并补充同义词；不要解释词义或读音，不要回答问题，只输出查询。' },
        { role: 'user', content: clean }
      ]
    });
    const out = (r.choices?.[0]?.message?.content || '').trim().split('\n')[0];
    return out.replace(/^["“]|["”]$/g, '').trim() || question;
  } catch {
    return question;
  }
}

function tokenize(text) {
  const cleaned = text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, ' ').trim();
  const tokens = [];
  for (const part of cleaned.split(/\s+/)) {
    if (!part) continue;
    if (/^\p{Script=Han}+$/u.test(part)) {
      if (part.length === 1) tokens.push(part);
      for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2));
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

function bm25Scores(query, chunks) {
  const docs = chunks.map(c => tokenize(c.text));
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.length, 0) / N;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = tokenize(query);
  const k1 = 1.2, b = 0.75;
  return docs.map(d => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avgdl));
    }
    return score;
  });
}

export async function retrieve(question, idx) {
  const searchQuery = await rewriteQuery(question);

  const [qr1, qr2] = await Promise.all([
    api('/embeddings', { model: CONFIG.embedModel, input: question }),
    searchQuery !== question
      ? api('/embeddings', { model: CONFIG.embedModel, input: searchQuery })
      : Promise.resolve(null)
  ]);
  const qv1 = qr1.data[0].embedding;
  const qv2 = qr2 ? qr2.data[0].embedding : null;

  const bm = bm25Scores(`${question} ${searchQuery}`, idx.chunks);
  const scored = idx.chunks.map((c, i) => {
    const s1 = cosine(qv1, idx.vectors[i]);
    const s2 = qv2 ? cosine(qv2, idx.vectors[i]) : s1;
    return { ...c, i, bm: bm[i], sim1: s1, sim2: s2, sim: Math.max(s1, s2) };
  });

  const byVec = [...scored].sort((a, b) => b.sim - a.sim);
  const byBm = [...scored].sort((a, b) => b.bm - a.bm);
  const vecRank = new Map(byVec.map((c, i) => [c.i, i]));
  const bmRank = new Map(byBm.map((c, i) => [c.i, i]));
  for (const c of scored) {
    c.fused = 1 / (60 + vecRank.get(c.i)) + 1 / (60 + bmRank.get(c.i));
  }
  const candidates = [...scored].sort((a, b) => b.fused - a.fused).slice(0, CONFIG.topRecall);

  const documents = candidates.map(c => c.text.slice(0, 600));
  const rerankOnce = query => api('/rerank', {
    model: CONFIG.rerankModel,
    query,
    documents,
    top_n: CONFIG.topRecall,
    return_documents: false
  });
  const [rr1, rr2] = await Promise.all([
    rerankOnce(question),
    searchQuery !== question ? rerankOnce(searchQuery) : Promise.resolve(null)
  ]);
  const rerankScore = new Map();
  for (const r of rr1.results) rerankScore.set(r.index, r.relevance_score);
  if (rr2) {
    for (const r of rr2.results) {
      rerankScore.set(r.index, Math.max(rerankScore.get(r.index) || 0, r.relevance_score));
    }
  }
  const top = [...rerankScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.topRerank)
    .map(([i, score]) => ({ ...candidates[i], rerank: score }));

  return { candidates, top, searchQuery };
}

function ensureCitation(text, top) {
  if (!text || /\[\d+\]/.test(text) || /未找到|没有找到/.test(text) || !top.length) return text;
  return `${text}\n\n来源：[1] §${top[0].section} ${top[0].title}`;
}

export async function answer(question, idx) {
  const { candidates, top, searchQuery } = await retrieve(question, idx);
  const context = top.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n');
  const r = await api('/chat/completions', {
    model: CONFIG.chatModel,
    temperature: 0,
    max_tokens: 600,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `【检索改写】${searchQuery}\n\n【资料】\n${context}\n\n【问题】${question}` }
    ]
  });
  const raw = (r.choices?.[0]?.message?.content || '').trim();
  return { text: ensureCitation(raw, top), candidates, top, searchQuery };
}

/**
 * 流式版本：先完成检索并回调 citations，再逐 token 输出答案。
 */
export async function answerStream(question, idx, { onStatus, onMeta, onToken } = {}) {
  onStatus?.('retrieve');
  const { candidates, top, searchQuery } = await retrieve(question, idx);
  const citations = top.map((c, i) => ({
    n: i + 1,
    section: c.section,
    title: c.title,
    url: c.url,
    rerank: c.rerank,
    sim: c.sim
  }));
  onMeta?.({ rewritten: searchQuery, citations });

  onStatus?.('generate');
  const context = top.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n');
  const res = await fetch(CONFIG.base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CONFIG.chatModel,
      temperature: 0,
      max_tokens: 600,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `【检索改写】${searchQuery}\n\n【资料】\n${context}\n\n【问题】${question}` }
      ]
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chat HTTP ${res.status}: ${text.slice(0, 240)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
      } catch {
        // 忽略不完整的 SSE 片段
      }
    }
  }

  const finalText = ensureCitation(text, top);
  if (finalText !== text) onToken?.(finalText.slice(text.length));

  return { text: finalText, citations, rewritten: searchQuery, candidates, top };
}

export function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const parseLine = line => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const row = {};
    header.forEach((h, i) => row[h] = vals[i]);
    return row;
  });
}

const SAMPLE_IDS = [1, 7, 15, 19, 29, 37, 49, 61, 65, 78, 86, 96];

export async function evaluate(n, idx, log = console.log) {
  const rows = parseCsv(path.join(DATA_DIR, 'eval-questions-100.csv'));
  let sample;
  if (n <= SAMPLE_IDS.length) {
    sample = SAMPLE_IDS.slice(0, n).map(id => rows.find(r => Number(r.id) === id)).filter(Boolean);
  } else {
    const step = Math.floor(rows.length / n);
    sample = Array.from({ length: n }, (_, i) => rows[Math.min(i * step, rows.length - 1)]);
  }

  const results = [];
  for (const row of sample) {
    const expected = row.source_section === '无' ? null : row.source_section.replace('§', '');
    const { text, candidates, top } = await answer(row.question, idx);
    const topSections = top.map(c => c.section);
    const recallSections = candidates.map(c => c.section);
    const r = {
      id: Number(row.id),
      type: row.type,
      question: row.question,
      expected,
      hit12: expected ? recallSections.includes(expected) : null,
      hit5: expected ? topSections.includes(expected) : null,
      abstain: row.should_abstain === '1' ? /未找到|没有找到|无法回答|未覆盖|不提供/.test(text) : null,
      handoff: row.should_handoff === '1' ? /人工|客服/.test(text) : null,
      cite: /\[\d+\]/.test(text),
      answer: text.replace(/\n+/g, ' ').slice(0, 80)
    };
    results.push(r);
    const fmt = v => v === null ? ' - ' : v ? ' ✓ ' : ' ✗ ';
    log(
      `#${String(row.id).padStart(3)} ${row.type.padEnd(12)} ` +
      `hit12=${fmt(r.hit12)} hit5=${fmt(r.hit5)} ` +
      `abstain=${fmt(r.abstain)} handoff=${fmt(r.handoff)} ` +
      `cite=${fmt(r.cite)}  ${row.question}`
    );
  }

  const count = arr => arr.filter(v => v === true).length;
  const known = arr => arr.filter(v => v !== null).length;
  const retrieval = results.filter(r => r.expected);
  const abstainRows = results.filter(r => r.abstain !== null);
  const handoffRows = results.filter(r => r.handoff !== null);
  const summary = {
    samples: results.length,
    recall12: retrieval.length ? { hit: count(retrieval.map(r => r.hit12)), total: known(retrieval.map(r => r.hit12)) } : null,
    recall5: retrieval.length ? { hit: count(retrieval.map(r => r.hit5)), total: known(retrieval.map(r => r.hit5)) } : null,
    abstain: abstainRows.length ? { hit: count(abstainRows.map(r => r.abstain)), total: abstainRows.length } : null,
    handoff: handoffRows.length ? { hit: count(handoffRows.map(r => r.handoff)), total: handoffRows.length } : null,
    cite: { hit: count(results.map(r => r.cite)), total: results.length }
  };

  log('\n=== 汇总 ===');
  log(`样本 ${summary.samples} 条`);
  if (summary.recall12) log(`检索 Recall@12: ${summary.recall12.hit}/${summary.recall12.total}`);
  if (summary.recall5) log(`重排 Recall@5 : ${summary.recall5.hit}/${summary.recall5.total}`);
  if (summary.abstain) log(`拒答准确率: ${summary.abstain.hit}/${summary.abstain.total}`);
  if (summary.handoff) log(`转人工准确率: ${summary.handoff.hit}/${summary.handoff.total}`);
  log(`引用标注率: ${summary.cite.hit}/${summary.cite.total}`);

  return { results, summary };
}
