const $ = sel => document.querySelector(sel);

const state = {
  mode: 'static',
  demo: null,
  presets: []
};

const FALLBACK_PRESETS = [
  '怎么把报表导出成 Excel',
  '小书怎么发',
  '我要退款',
  '明天天气怎么样'
];

const TOKEN_KEY = 'rag_demo_token';
const DEBUG = new URLSearchParams(location.search).has('debug');
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setToken = t => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

let currentQuestion = '';
let lastCitations = [];
let docCache = null;
let pageMap = null;
let closeTimer = null;
let lastFocus = null;

function showTokenForm(show, note = '') {
  $('#token-form').hidden = !show;
  $('#token-note').hidden = !note;
  $('#token-note').textContent = note;
  if (show) $('#token-input').focus();
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderText(text) {
  return esc(text)
    .split(/\n{2,}/)
    .filter(Boolean)
    .map(p => `<p>${p.replace(/\n/g, '<br>').replace(/\[(\d+)\]/g, '<button type="button" class="cite" data-cite="$1">[$1]</button>')}</p>`)
    .join('');
}

function citationsHtml(citations) {
  const list = (citations || []).slice().sort((a, b) => a.n - b.n);
  if (!list.length) return '';
  return `
    <div class="citations">
      <h4>引用来源</h4>
      ${list.map(c => `
        <div class="cite-item" data-cite="${c.n}" role="button" tabindex="0">
          <div class="cite-top">
            <span class="cite-n">[${c.n}]</span>
            <span class="cite-sec">§${esc(c.section)}</span>
            <span class="cite-title">${esc(c.title)}</span>
          </div>
          <div class="cite-meta">
            rerank ${Number(c.rerank).toFixed(3)} · sim ${Number(c.sim).toFixed(3)}
            · <span class="cite-preview">预览原文 →</span>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderMode(health) {
  const el = $('#mode');
  if (state.mode === 'live') {
    el.className = 'mode live';
    el.textContent = `实时 API · ${health.chunks} chunks · ${health.dim} 维`;
  } else {
    el.className = 'mode static';
    el.textContent = '静态示例 · 运行 npm start 可实时提问';
  }
}

function renderChips() {
  const box = $('#chips');
  const questions = state.presets.length ? state.presets : FALLBACK_PRESETS;
  box.innerHTML = questions
    .map(q => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`)
    .join('');
  box.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      $('#question').value = btn.dataset.q;
      ask(btn.dataset.q);
    });
  });
}

function findDemo(question) {
  if (!state.demo?.items) return null;
  const exact = state.demo.items.find(it => it.question === question);
  if (exact) return exact;
  const norm = s => s.replace(/[\s“”"']/g, '').toLowerCase();
  return state.demo.items.find(it => {
    const a = norm(it.question);
    const b = norm(question);
    return a.includes(b) || b.includes(a);
  }) || null;
}

function renderAnswer(data) {
  lastCitations = data.citations || [];
  const rewritten = data.rewritten && data.rewritten !== data.question
    ? `<span class="rewrite">检索改写：${esc(data.rewritten)}</span>`
    : '';
  $('#answer').innerHTML = `${rewritten}${renderText(data.answer)}${citationsHtml(data.citations)}`;
}

function renderEvidence(citations) {
  const box = $('#evidence');
  const list = (citations || []).slice().sort((a, b) => a.n - b.n);
  if (!list.length) {
    box.innerHTML = '<div class="empty-state small">没有召回结果</div>';
    return;
  }
  box.innerHTML = list.map(c => {
    const rr = Math.max(0, Math.min(1, Number(c.rerank) || 0));
    const sim = Math.max(0, Math.min(1, Number(c.sim) || 0));
    return `
      <div class="evidence-item">
        <div class="evidence-top">
          <span class="evidence-sec">§${esc(c.section)}</span>
          <span class="evidence-title">${esc(c.title)}</span>
        </div>
        <div class="bars">
          <div class="bar-row">
            <span>rerank</span>
            <span class="bar"><i style="width:${(rr * 100).toFixed(1)}%"></i></span>
            <span>${rr.toFixed(3)}</span>
          </div>
          <div class="bar-row">
            <span>sim</span>
            <span class="bar"><i style="width:${(sim * 100).toFixed(1)}%"></i></span>
            <span>${sim.toFixed(3)}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderTrace(trace) {
  const box = $('#trace');
  if (!trace?.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="trace-title">LLM 调用 · ${trace.length} 次 · SiliconFlow</div>
    ${trace.map((t, i) => `
      <div class="trace-row">
        <span>${i + 1}</span>
        <span class="trace-ep" title="${esc(t.model || '')}">${esc(t.endpoint)}</span>
        <span class="trace-ms">${t.ms}ms</span>
      </div>`).join('')}`;
}

function setLoading(stage = 'retrieve') {
  const label = stage === 'generate' ? '生成答案中…' : '检索与重排中…';
  $('#reasoning-box').hidden = true;
  $('#reasoning-box').open = false;
  $('#reasoning-text').textContent = '';
  $('#answer').innerHTML = `
    <div class="stream-status">
      <span class="spinner"></span>
      <span>${label}</span>
    </div>`;
  $('#evidence').innerHTML = `
    <div class="loading">
      <i></i><i></i><i></i><i></i>
    </div>`;
  $('#trace').innerHTML = '';
  $('#elapsed').textContent = '';
}

function paintStream(meta, text, options = {}) {
  const rewritten = meta.rewritten && meta.rewritten !== currentQuestion
    ? `<span class="rewrite">检索改写：${esc(meta.rewritten)}</span>`
    : '';
  const body = text
    ? renderText(text) + (options.cursor ? '<span class="cursor"></span>' : '')
    : '<span class="typing">正在组织答案…</span>';
  $('#answer').innerHTML = `${rewritten}<div class="stream-text">${body}</div>${citationsHtml(meta.citations)}`;
}

function setError(message) {
  $('#answer').innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">!</span>
      <p>${esc(message)}</p>
      <small>静态模式只展示预置示例；运行 npm start 后可自由提问。</small>
    </div>`;
  $('#evidence').innerHTML = '<div class="empty-state small">没有召回结果</div>';
}

function setElapsed(ms) {
  $('#elapsed').textContent = ms ? `${(ms / 1000).toFixed(1)}s` : '';
}

async function loadDoc() {
  if (docCache) return docCache;
  const res = await fetch('./doc/help-center.html', { cache: 'force-cache' });
  if (!res.ok) throw new Error('原文加载失败');
  docCache = new DOMParser().parseFromString(await res.text(), 'text/html');
  return docCache;
}

async function getPageMap() {
  if (pageMap) return pageMap;
  try {
    const res = await fetch('./doc/pages.json', { cache: 'force-cache' });
    pageMap = res.ok ? await res.json() : {};
  } catch {
    pageMap = {};
  }
  return pageMap;
}

async function openSource(n) {
  const citation = lastCitations.find(c => Number(c.n) === Number(n));
  if (!citation) return;

  const overlay = $('#source-overlay');
  const drawer = $('#source-drawer');
  lastFocus = document.activeElement;
  clearTimeout(closeTimer);
  overlay.hidden = false;
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add('open'));
  document.body.style.overflow = 'hidden';

  $('#source-kicker').textContent = `§${citation.section}`;
  $('#source-title').textContent = citation.title;
  $('#source-body').innerHTML = '<div class="source-loading">加载原文…</div>';
  $('#source-close').focus();

  try {
    const [doc, pages] = await Promise.all([loadDoc(), getPageMap()]);
    const el = doc.querySelector(`#s${citation.section.replace('.', '-')}`);
    if (!el) throw new Error('原文中找不到该小节');

    const chapterTitle = (el.closest('section')?.querySelector('h1')?.textContent?.trim() || '')
      .replace(/^\d+[　\s]+/, '');
    if (chapterTitle) $('#source-kicker').textContent = `§${citation.section} · ${chapterTitle}`;

    const wrap = document.createElement('div');
    let node = el.nextElementSibling;
    while (node && !['H1', 'H2', 'SECTION'].includes(node.tagName)) {
      wrap.appendChild(node.cloneNode(true));
      node = node.nextElementSibling;
    }

    const hitText = citation.text
      ? citation.text.replace(/^§[\d.]+\s+[^\n]*\n+/, '').slice(0, 700)
      : '';
    const hit = hitText
      ? `<div class="hit"><div class="hit-label">命中片段</div><p>${esc(hitText).replace(/\n/g, '<br>')}</p></div>`
      : '';
    $('#source-body').innerHTML = hit + wrap.innerHTML;

    const page = pages[citation.section] || 1;
    $('#source-pdf').href = `./doc/help-center.pdf#page=${page}`;
    $('#source-html').href = `./doc/help-center.html#s${citation.section.replace('.', '-')}`;
  } catch (err) {
    $('#source-body').innerHTML = `<div class="source-loading">${esc(err.message)}</div>`;
  }
}

function closeSource() {
  const drawer = $('#source-drawer');
  drawer.classList.remove('open');
  document.body.style.overflow = '';
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    drawer.hidden = true;
    $('#source-overlay').hidden = true;
  }, 200);
  lastFocus?.focus?.();
}

async function askLive(q) {
  const startedAt = performance.now();
  let firstTokenAt = 0;
  let meta = { citations: [], rewritten: '' };
  let text = '';
  let reasoning = '';

  console.groupCollapsed(`%c[RAG] ${q}`, 'color:#0f766e;font-weight:700');
  console.log('question:', q);
  console.log('mode:', 'live SSE');

  try {
    const token = getToken();
    const res = await fetch('/api/ask/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ question: q })
    });

    if (res.status === 401) {
      showTokenForm(true, '访问口令不正确，请重新输入');
      throw new Error('需要访问口令');
    }

    if (!res.ok) {
      let message = `请求失败 (${res.status})`;
      try { message = (await res.json()).error || message; } catch { /* ignore */ }
      throw new Error(message);
    }

    console.log(`[连接] ${(performance.now() - startedAt).toFixed(0)}ms`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotMeta = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;

        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === 'status') {
          if (!gotMeta) setLoading(payload.stage);
          if (DEBUG) console.log(`[status] ${payload.stage} @ ${(performance.now() - startedAt).toFixed(0)}ms`);
        } else if (event === 'meta') {
          meta = payload;
          gotMeta = true;
          lastCitations = meta.citations || [];
          paintStream(meta, '', { cursor: true });
          renderEvidence(meta.citations);
          console.log(`[检索] ${(performance.now() - startedAt).toFixed(0)}ms`);
          console.log('检索改写:', meta.rewritten || '(未改写)');
          console.table((meta.citations || []).map(c => ({
            n: c.n,
            section: '§' + c.section,
            title: c.title,
            rerank: Number(c.rerank).toFixed(3),
            sim: Number(c.sim).toFixed(3)
          })));
        } else if (event === 'reasoning') {
          reasoning += payload.text || '';
          const box = $('#reasoning-box');
          if (box.hidden) {
            box.hidden = false;
            box.open = true;
          }
          $('#reasoning-text').textContent = reasoning;
          if (DEBUG) console.debug('[reasoning]', JSON.stringify(payload.text));
        } else if (event === 'token') {
          text += payload.text || '';
          if (!firstTokenAt) {
            firstTokenAt = performance.now();
            console.log(`[首字] ${(firstTokenAt - startedAt).toFixed(0)}ms`);
          }
          if (DEBUG) console.debug('[token]', JSON.stringify(payload.text));
          paintStream(meta, text, { cursor: true });
        } else if (event === 'done') {
          setElapsed(payload.elapsedMs);
          paintStream(meta, text, { cursor: false });
          renderTrace(payload.trace);
          const total = performance.now() - startedAt;
          console.log('answer:', text);
          console.log('reasoning:', reasoning || '(模型未返回思考过程)');
          if (payload.trace) {
            console.table(payload.trace.map((t, i) => ({
              step: i + 1,
              endpoint: t.endpoint,
              model: t.model,
              ms: t.ms,
              inputs: t.inputs ?? '',
              docs: t.documents ?? '',
              tokens: t.usage?.total_tokens ?? t.usage?.input_tokens ?? '',
              reasoningTokens: t.usage?.completion_tokens_details?.reasoning_tokens ?? ''
            })));
          }
          console.log(`[完成] ${total.toFixed(0)}ms · ${payload.trace?.length || 0} 次 SiliconFlow 调用 · ${text.length} 字`);
          window.__RAG_LAST__ = {
            question: q,
            rewritten: meta.rewritten,
            citations: meta.citations,
            trace: payload.trace,
            answer: text,
            reasoning,
            elapsedMs: payload.elapsedMs
          };
        } else if (event === 'error') {
          throw new Error(payload.message || '生成失败');
        }
      }
    }

    if (!gotMeta) throw new Error('没有拿到检索结果');
  } catch (err) {
    console.error('[RAG] 失败:', err.message);
    throw err;
  } finally {
    console.groupEnd();
  }
}

async function ask(question) {
  const q = question.trim();
  if (!q) return;
  currentQuestion = q;
  const btn = $('#ask-btn');
  btn.disabled = true;
  setLoading();

  try {
    if (state.mode === 'live') {
      await askLive(q);
    } else {
      const data = findDemo(q);
      if (!data) throw new Error('这个问题不在静态示例里');
      console.groupCollapsed(`%c[RAG·静态] ${q}`, 'color:#b45309;font-weight:700');
      console.log('answer:', data.answer);
      console.log('检索改写:', data.rewritten || '(未改写)');
      console.table((data.citations || []).map(c => ({
        n: c.n,
        section: '§' + c.section,
        title: c.title,
        rerank: Number(c.rerank).toFixed(3),
        sim: Number(c.sim).toFixed(3)
      })));
      console.groupEnd();
      window.__RAG_LAST__ = data;
      renderAnswer(data);
      renderEvidence(data.citations);
      setElapsed(data.elapsedMs);
    }
  } catch (err) {
    console.error('[RAG] 请求失败:', err.message);
    setError(err.message || '请求失败');
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  try {
    const res = await fetch('./demo-data.json', { cache: 'no-store' });
    if (res.ok) {
      state.demo = await res.json();
      state.presets = (state.demo.items || []).map(it => it.question);
    }
  } catch {
    // 静态数据加载失败时使用内置示例
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (res.ok) {
      const health = await res.json();
      state.mode = 'live';
      renderMode(health);
      if (health.authRequired) {
        $('#token-toggle').hidden = false;
        if (!getToken()) showTokenForm(true);
      }
    } else {
      renderMode();
    }
  } catch {
    renderMode();
  }

  renderChips();
}

$('#ask-form').addEventListener('submit', e => {
  e.preventDefault();
  ask($('#question').value);
});

$('#token-form').addEventListener('submit', e => {
  e.preventDefault();
  const token = $('#token-input').value.trim();
  if (!token) return;
  setToken(token);
  showTokenForm(false);
  $('#answer').innerHTML = `
    <div class="empty-state">
      <span class="empty-icon">✓</span>
      <p>口令已保存</p>
      <small>点上面的示例开始提问</small>
    </div>`;
});

$('#token-toggle').addEventListener('click', () => {
  showTokenForm($('#token-form').hidden);
});

document.addEventListener('click', e => {
  const cite = e.target.closest?.('[data-cite]');
  if (cite) {
    e.preventDefault();
    openSource(cite.dataset.cite);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#source-drawer').hidden) {
    closeSource();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target?.matches?.('[data-cite]')) {
    e.preventDefault();
    openSource(e.target.dataset.cite);
  }
});

$('#source-close').addEventListener('click', closeSource);
$('#source-overlay').addEventListener('click', closeSource);

init();
