/**
 * Claude.ai conversation → Markdown export bookmarklet
 *
 * Run it while viewing https://claude.ai/chat/<uuid>.
 * It uses Claude's own internal JSON API (same session cookies the page
 * uses), so it captures the full conversation without DOM scraping —
 * including messages scrolled out of view / virtualized away.
 *
 * Output: a downloaded .md file. Filename defaults to
 *   claude_<slugified-title>_<short-id>.md
 * and a prompt() lets you edit it before saving.
 *
 * @title Export Claude Conversation
 * @description Downloads the claude.ai conversation you are viewing as a Markdown
 *              file, including thinking blocks, tool calls and attachments.
 * @order 10
 */
(async () => {
  try {
    // 1. Conversation id from the URL
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    if (!m) {
      alert('Open a conversation first (URL must look like /chat/<uuid>).');
      return;
    }
    const convId = m[1];

    // 2. Organization id: prefer the lastActiveOrg cookie, fall back to API
    let orgId = (document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1];
    if (!orgId) {
      const orgs = await (await fetch('/api/organizations', { credentials: 'include' })).json();
      const org = orgs.find(o => (o.capabilities || []).includes('chat')) || orgs[0];
      orgId = org && org.uuid;
    }
    if (!orgId) { alert('Could not determine organization id — are you logged in?'); return; }

    // 3. Fetch the full conversation tree
    const url = `/api/organizations/${orgId}/chat_conversations/${convId}` +
                `?tree=True&rendering_mode=messages&render_all_tools=true`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { alert(`API request failed (${res.status}). Claude may have changed its API.`); return; }
    const conv = await res.json();

    // 4. Render one message's content blocks as markdown
    const renderBlock = (b) => {
      switch (b.type) {
        case 'text':
          return b.text || '';
        case 'thinking':
          return b.thinking
            ? `<details><summary>Thinking</summary>\n\n${b.thinking}\n\n</details>`
            : '';
        case 'tool_use':
          return '```json\n' +
                 `// tool_use: ${b.name || 'unknown'}\n` +
                 JSON.stringify(b.input || {}, null, 2) + '\n```';
        case 'tool_result': {
          const txt = Array.isArray(b.content)
            ? b.content.map(c => c.text || '').join('\n')
            : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
          return '```\n' + `[tool_result${b.is_error ? ' (error)' : ''}]\n` + txt + '\n```';
        }
        default:
          return b.text || '';
      }
    };

    const renderMsg = (msg) => {
      const role = msg.sender === 'human' ? 'Human' : 'Assistant';
      const parts = (msg.content && msg.content.length)
        ? msg.content.map(renderBlock).filter(Boolean)
        : [msg.text || ''];
      // Attachments / uploaded files, if any
      const extras = [];
      (msg.attachments || []).forEach(a => {
        extras.push(`> **Attachment:** ${a.file_name || 'file'}` +
          (a.extracted_content ? `\n\n\`\`\`\n${a.extracted_content}\n\`\`\`` : ''));
      });
      (msg.files || []).forEach(f => extras.push(`> **File:** ${f.file_name || f.file_kind || 'file'}`));
      return `## ${role}\n\n${[...extras, ...parts].join('\n\n')}`;
    };

    const msgs = (conv.chat_messages || [])
      .slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const title = conv.name || 'Untitled conversation';
    const md = [
      `# ${title}`,
      '',
      `- **Conversation ID:** ${convId}`,
      `- **URL:** ${location.origin}/chat/${convId}`,
      `- **Created:** ${conv.created_at || 'unknown'}`,
      `- **Exported:** ${new Date().toISOString()}`,
      `- **Messages:** ${msgs.length}`,
      '',
      '---',
      '',
      msgs.map(renderMsg).join('\n\n---\n\n'),
      ''
    ].join('\n');

    // 5. Filename: derived from title + short id, editable via prompt()
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const suggested = `claude_${slug || 'conversation'}_${convId.slice(0, 8)}.md`;
    const filename = prompt('Save conversation as:', suggested);
    if (!filename) return; // user cancelled

    // 6. Download
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
