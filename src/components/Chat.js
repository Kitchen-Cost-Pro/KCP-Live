import { callCloudflareWorkspaceRoute } from '../services/cloudflareApi.js';

const SUGGESTIONS = [
  'What is low stock?',
  'Top 5 selling items',
  'Worst GP products',
  'Show all stock levels',
];

let chatState = {
  open: false,
  expanded: false,
  messages: [], // { role: 'user'|'assistant'|'error', content: string }
  loading: false,
  workspaceId: null
};

let chatRoot = null;

function svgIcon(type) {
  switch (type) {
    case 'chat':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    case 'close':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    case 'send':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    case 'spark':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/></svg>`;
    case 'expand':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    case 'contract':
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`;
    default:
      return '';
  }
}

function renderChat() {
  if (!chatRoot) return;

  const { open, messages, loading } = chatState;
  const historyForApi = messages
    .filter((m) => m.role !== 'error')
    .map((m) => ({ role: m.role, content: m.content }));

  chatRoot.innerHTML = `
    <button class="kcpChat__toggle ${open ? 'kcpChat__toggle--open' : ''}" id="kcpChat-toggle" aria-label="${open ? 'Close assistant' : 'Open KCP Assistant'}">
      ${open ? svgIcon('close') : svgIcon('chat')}
    </button>

    <div class="kcpChat__panel ${open ? '' : 'is-hidden'} ${chatState.expanded ? 'kcpChat__panel--expanded' : ''}" aria-label="KCP Assistant">
      <div class="kcpChat__header">
        <div class="kcpChat__headerIcon">${svgIcon('spark')}</div>
        <div class="kcpChat__headerText">
          <strong>KCP Assistant</strong>
        </div>
        <button class="kcpChat__headerExpand" id="kcpChat-expand" aria-label="${chatState.expanded ? 'Shrink' : 'Expand'}">
          ${svgIcon(chatState.expanded ? 'contract' : 'expand')}
        </button>
        <button class="kcpChat__headerClose" id="kcpChat-close" aria-label="Close">
          ${svgIcon('close')}
        </button>
      </div>

      <div class="kcpChat__messages" id="kcpChat-messages">
        ${messages.length === 0 ? `
          <div class="kcpChat__empty">
            ${svgIcon('spark')}
            <p>Ask me anything about your stock, recipes, or sales.</p>
            <div class="kcpChat__suggestions">
              ${SUGGESTIONS.map((s) => `<button class="kcpChat__suggestion" data-suggestion="${s}">${s}</button>`).join('')}
            </div>
          </div>
        ` : messages.map((m) => `
          <div class="kcpChat__bubble kcpChat__bubble--${m.role}">
            <div class="kcpChat__bubbleBody">
              ${m.chartData ? `<canvas class="kcpChat__chart" data-chart='${JSON.stringify(m.chartData)}'></canvas>` : ''}
              ${m.role === 'user' ? escapeHtml(m.content) : renderMarkdown(m.content)}
            </div>
          </div>
        `).join('')}

        ${loading ? `
          <div class="kcpChat__bubble kcpChat__bubble--assistant">
            <div class="kcpChat__thinking">
              <span></span><span></span><span></span>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="kcpChat__inputRow">
        <textarea
          class="kcpChat__input"
          id="kcpChat-input"
          placeholder="Ask about stock, recipes, GP…"
          rows="1"
          ${loading ? 'disabled' : ''}
        ></textarea>
        <button class="kcpChat__send" id="kcpChat-send" ${loading ? 'disabled' : ''} aria-label="Send">
          ${svgIcon('send')}
        </button>
      </div>
    </div>
  `;

  // Scroll messages to bottom
  const messagesEl = document.getElementById('kcpChat-messages');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

  // Wire events
  document.getElementById('kcpChat-toggle')?.addEventListener('click', () => {
    chatState.open = !chatState.open;
    renderChat();
    if (chatState.open) setTimeout(() => document.getElementById('kcpChat-input')?.focus(), 50);
  });

  document.getElementById('kcpChat-expand')?.addEventListener('click', () => {
    chatState.expanded = !chatState.expanded;
    renderChat();
  });

  document.getElementById('kcpChat-close')?.addEventListener('click', () => {
    chatState.open = false;
    renderChat();
  });

  document.getElementById('kcpChat-send')?.addEventListener('click', handleSend);

  document.getElementById('kcpChat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
  const textarea = document.getElementById('kcpChat-input');
  if (textarea) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
    });
  }

  // Draw any bar charts
  chatRoot.querySelectorAll('canvas[data-chart]').forEach((canvas) => {
    try {
      const data = JSON.parse(canvas.dataset.chart);
      drawBarChart(canvas, data);
    } catch { /* ignore */ }
  });

  // Suggestion chips
  chatRoot.querySelectorAll('[data-suggestion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const suggestion = btn.dataset.suggestion;
      if (suggestion) sendMessage(suggestion);
    });
  });
}

async function handleSend() {
  const input = document.getElementById('kcpChat-input');
  const message = (input?.value || '').trim();
  if (!message || chatState.loading) return;
  if (input) input.value = '';
  sendMessage(message);
}

async function sendMessage(message) {
  if (!chatState.workspaceId) return;

  const history = chatState.messages
    .filter((m) => m.role !== 'error')
    .map((m) => ({ role: m.role, content: m.content }));

  chatState.messages = [...chatState.messages, { role: 'user', content: message }];
  chatState.loading = true;
  renderChat();

  try {
    const result = await callCloudflareWorkspaceRoute(chatState.workspaceId, 'chat', {
      method: 'POST',
      payload: { message, history }
    });

    const msg = { role: 'assistant', content: result.answer || 'No response.' };
    if (result.chartData) msg.chartData = result.chartData;
    chatState.messages = [...chatState.messages, msg];
  } catch (e) {
    chatState.messages = [...chatState.messages, {
      role: 'error',
      content: e?.message || 'Something went wrong. Please try again.'
    }];
  }

  chatState.loading = false;
  renderChat();
}

function drawBarChart(canvas, { labels, values, color = '#2563eb' }) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth || 340;
  const H = 140;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 10, right: 10, bottom: 32, left: 50 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;
  const max = Math.max(...values, 1);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch - (i / 4) * ch;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(`R${((max * i / 4)).toFixed(0)}`, pad.left - 4, y + 3);
  }

  const barW = Math.max(4, cw / labels.length - 4);
  labels.forEach((label, i) => {
    const x = pad.left + i * (cw / labels.length) + (cw / labels.length - barW) / 2;
    const barH = (values[i] / max) * ch;
    const y = pad.top + ch - barH;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [3, 3, 0, 0]);
    ctx.fill();
    ctx.globalAlpha = 1;

    // X label
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '8px system-ui';
    ctx.textAlign = 'center';
    const shortLabel = label.slice(8); // show DD from YYYY-MM-DD
    ctx.fillText(shortLabel, x + barW / 2, H - pad.bottom + 12);
  });
}

function renderMarkdown(str = '') {
  // Strip hallucinated raw tool call tags
  let s = String(str).replace(/<function=[^>]*>[^<]*<\/function>/gi, '').trim();

  // SECURITY: escape the entire message BEFORE applying markdown, so assistant output
  // (which can contain workspace data or prompt-injected payloads) can never inject HTML.
  // Markdown chars (* # - |) survive escaping, so the transforms below still work; cells
  // are already escaped here so they are inserted raw.
  s = escapeHtml(s);

  // Tables: | col | col |
  s = s.replace(/\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g, (_, header, body) => {
    const ths = header.split('|').map(c => c.trim()).filter(Boolean)
      .map(c => `<th>${c}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const tds = row.split('|').map(c => c.trim()).filter(Boolean)
        .map(c => `<td>${c}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<div class="kcpChat__tableWrap"><table class="kcpChat__table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
  });

  // Headings
  s = s.replace(/^### (.+)$/gm, '<h4 style="font-size:0.78rem;font-weight:700;margin:6px 0 2px;color:var(--text-main)">$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3 style="font-size:0.82rem;font-weight:700;margin:6px 0 2px;color:var(--text-main)">$1</h3>');
  // Bold **text**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Bullet lines starting with * or -
  s = s.replace(/^[*-] (.+)/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  // Line breaks (skip after headings/list items)
  s = s.replace(/\n/g, '<br>');

  return s;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mountChatWidget(workspaceId) {
  chatState.workspaceId = workspaceId;
  chatState.messages = [];
  chatState.loading = false;
  chatState.open = false;

  if (!chatRoot) {
    chatRoot = document.createElement('div');
    chatRoot.id = 'kcp-chat-widget';
    document.body.appendChild(chatRoot);
  }

  renderChat();
}

export function unmountChatWidget() {
  chatState.workspaceId = null;
  chatState.messages = [];
  chatState.open = false;
  if (chatRoot) {
    chatRoot.innerHTML = '';
  }
}
