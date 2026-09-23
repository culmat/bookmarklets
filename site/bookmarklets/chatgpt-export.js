/**
 * ChatGPT conversation → Markdown export bookmarklet
 *
 * Run it while viewing https://chatgpt.com/c/<uuid> (also works inside
 * projects / custom GPTs: /g/<gizmo>/c/<uuid>).
 * It uses ChatGPT's own internal JSON API (the page's session is exchanged
 * for a bearer token via /api/auth/session), so it captures the full
 * conversation without DOM scraping.
 *
 * ChatGPT stores a conversation as a tree (every edit / regenerate forks it).
 * The export follows the branch currently shown on screen: from
 * `current_node` back up to the root.
 *
 * Output: a downloaded .md file. Filename defaults to
 *   chatgpt_<slugified-title>_<short-id>.md
 * and a prompt() lets you edit it before saving.
 *
 * @title Export ChatGPT Conversation
 * @description Downloads the chatgpt.com conversation you are viewing as a Markdown
 *              file, including reasoning summaries, tool calls and attachments.
 * @order 20
 */
(async () => {
  try {
    // 1. Conversation id from the URL
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (!m) {
      alert('Open a conversation first (URL must look like /c/<uuid>).');
      return;
    }
    const convId = m[1];

    // 2. Access token from the logged-in session
    const session = await (await fetch('/api/auth/session', { credentials: 'include' })).json();
    const token = session && session.accessToken;
    if (!token) { alert('Could not get an access token — are you logged in?'); return; }

    // 3. Fetch the full conversation tree
    const res = await fetch(`/backend-api/conversation/${convId}`, {
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { alert(`API request failed (${res.status}). ChatGPT may have changed its API.`); return; }
    const conv = await res.json();

    // 4. Walk the visible branch: current_node → root, then reverse
    const mapping = conv.mapping || {};
    const chain = [];
    for (let id = conv.current_node; id && mapping[id]; id = mapping[id].parent) {
      chain.push(mapping[id]);
    }
    chain.reverse();

    // Inline citation markers look like \ue200cite\ue202turn0search0\ue201;
    // replace them with the rendered link text where the API provides one.
    // Only references whose matched_text contains such a marker are applied:
    // some (e.g. the sources footnote) match a plain ' ', which would
    // otherwise strip every space from the message.
    const MARKER = /[\ue200-\ue2ff]/;
    const cleanText = (text, meta) => {
      let t = text || '';
      ((meta && meta.content_references) || []).forEach(r => {
        if (r.matched_text && MARKER.test(r.matched_text)) t = t.split(r.matched_text).join(r.alt || '');
      });
      return t.replace(/[\ue200-\ue2ff]/g, '');
    };

    const fence = (lang, body) => '```' + (lang || '') + '\n' + (body || '').replace(/\n$/, '') + '\n```';

    // 5. Render one message as markdown (or '' to skip it)
    const renderMsg = (msg) => {
      const meta = msg.metadata || {};
      if (meta.is_visually_hidden_from_conversation) return '';
      const role = msg.author && msg.author.role;
      if (role === 'system') return '';
      const c = msg.content || {};
      let body = '';

      switch (c.content_type) {
        case 'text':
          body = cleanText((c.parts || []).join('\n'), meta);
          break;
        case 'multimodal_text':
          body = (c.parts || []).map(p => {
            if (typeof p === 'string') return cleanText(p, meta);
            if (p.content_type === 'image_asset_pointer') return `> **Image:** ${p.asset_pointer || 'image'}`;
            if (p.content_type === 'audio_transcription') return p.text || '';
            return p.text || '';
          }).filter(Boolean).join('\n\n');
          break;
        case 'code':
          // Assistant calling a tool (python, web search, canvas, …)
          body = `*Tool call → ${msg.recipient || 'tool'}*\n\n` +
                 fence(c.language === 'unknown' ? '' : c.language, c.text);
          break;
        case 'execution_output':
          body = fence('', `[output]\n${c.text || ''}`);
          break;
        case 'thoughts':
          body = (c.thoughts || []).length
            ? '<details><summary>Thinking</summary>\n\n' +
              c.thoughts.map(t => (t.summary ? `**${t.summary}**\n\n` : '') + (t.content || '')).join('\n\n') +
              '\n\n</details>'
            : '';
          break;
        case 'reasoning_recap':
          body = c.content ? `*${c.content}*` : '';
          break;
        case 'tether_quote':
          body = `> **Quote from [${c.title || c.domain || c.url}](${c.url})**\n>\n> ` +
                 (c.text || '').split('\n').join('\n> ');
          break;
        case 'tether_browsing_display':
          body = c.result ? fence('', `[browsing]\n${c.result}`) : '';
          break;
        case 'system_error':
          body = `> **Error:** ${c.name || ''} ${c.text || ''}`.trim();
          break;
        case 'user_editable_context':
        case 'model_editable_context':
          return ''; // custom instructions / memory — not part of the dialogue
        default:
          body = c.text || (Array.isArray(c.parts) ? c.parts.filter(p => typeof p === 'string').join('\n') : '');
      }

      const extras = (meta.attachments || []).map(a => `> **Attachment:** ${a.name || a.id || 'file'}`);
      const parts = [...extras, body].filter(s => s && s.trim());
      if (!parts.length) return '';

      const heading = role === 'user' ? 'User'
        : role === 'tool' ? `Tool${msg.author.name ? ` (${msg.author.name})` : ''}`
        : `Assistant${meta.model_slug ? ` (${meta.model_slug})` : ''}`;
      return `## ${heading}\n\n${parts.join('\n\n')}`;
    };

    const rendered = chain.map(n => n.message).filter(Boolean).map(renderMsg).filter(Boolean);

    const title = conv.title || 'Untitled conversation';
    const iso = (s) => (s ? new Date(s * 1000).toISOString() : 'unknown');
    const md = [
      `# ${title}`,
      '',
      `- **Conversation ID:** ${convId}`,
      `- **URL:** ${location.origin}/c/${convId}`,
      `- **Created:** ${iso(conv.create_time)}`,
      `- **Updated:** ${iso(conv.update_time)}`,
      `- **Exported:** ${new Date().toISOString()}`,
      `- **Messages:** ${rendered.length}`,
      '',
      '---',
      '',
      rendered.join('\n\n---\n\n'),
      ''
    ].join('\n');

    // 6. Filename: derived from title + short id, editable via prompt()
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const suggested = `chatgpt_${slug || 'conversation'}_${convId.slice(0, 8)}.md`;
    const filename = prompt('Save conversation as:', suggested);
    if (!filename) return; // user cancelled

    // 7. Download
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith('.md') ? filename : filename + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {
    alert('Export failed: ' + e.message);
    console.error(e);
  }
})();
