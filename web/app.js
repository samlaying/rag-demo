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

let currentQuestion = '';

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
    .map(p => `<p>${p.replace(/\n/g, '<br>').replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>')}</p>`)
    .join('');
}

function citationsHtml(citations) {
  const list = (citations || []).slice().sort((a, b) => a.n - b.n);
  if (!list.length) return '';
  return `
    <div class="citations">
      <h4>引用来源</h4>
      ${list.map(c => `
        <div class="cite-item">
          <div class="cite-top">
            <span class="cite-n">[${c.n}]</span>
            <span class="cite-sec">§${esc(c.section)}</span>
            <span class="cite-title">${esc(c.title)}</span>
          </div>
          <div class="cite-meta">
            rerank ${Number(c.rerank).toFixed(3)} · sim ${Number(c.sim).toFixed(3)}
            ${c.url ? ` · <a href="${esc(c.url)}" target="_blank" rel="noreferrer">查看原文</a>` : ''}
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

function setLoading(stage = 'retrieve') {
  const label = stage === 'generate' ? '生成答案中…' : '检索与重排中…';
  $('#answer').innerHTML = `
    <div class="stream-status">
      <span class="spinner"></span>
      <span>${label}</span>
    </div>`;
  $('#evidence').innerHTML = `
    <div class="loading">
      <i></i><i></i><i></i><i></i>
    </div>`;
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

async function askLive(q) {
  const res = await fetch('/api/ask/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: q })
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try { message = (await res.json()).error || message; } catch { /* ignore */ }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let meta = { citations: [], rewritten: '' };
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
        // meta 到达后不再重置，否则会把引用和证据链清空
        if (!gotMeta) setLoading(payload.stage);
      } else if (event === 'meta') {
        meta = payload;
        gotMeta = true;
        paintStream(meta, '', { cursor: true });
        renderEvidence(meta.citations);
      } else if (event === 'token') {
        text += payload.text || '';
        paintStream(meta, text, { cursor: true });
      } else if (event === 'done') {
        setElapsed(payload.elapsedMs);
        paintStream(meta, text, { cursor: false });
      } else if (event === 'error') {
        throw new Error(payload.message || '生成失败');
      }
    }
  }

  if (!gotMeta) throw new Error('没有拿到检索结果');
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
      renderAnswer(data);
      renderEvidence(data.citations);
      setElapsed(data.elapsedMs);
    }
  } catch (err) {
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

init();
