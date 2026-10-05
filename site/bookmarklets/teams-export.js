/**
 * Microsoft Teams chat → Markdown (+ images) export bookmarklet
 *
 * Run it in the Teams web app (teams.cloud.microsoft / teams.microsoft.com)
 * while a chat is open. It uses Teams' own chat service API with the tokens
 * the logged-in page already holds, so it captures the whole history
 * without scrolling or DOM scraping.
 *
 * Inline images (pasted screenshots, photos) are downloaded too. The export
 * is then a .zip holding the .md file plus an images/ folder it links to;
 * a chat without images is saved as a plain .md file. Shared files
 * (SharePoint / OneDrive) are linked, not downloaded.
 *
 * Output filename defaults to
 *   teams_<slugified-topic>_<short-id>.zip (or .md)
 * and a prompt() lets you edit it before saving.
 *
 * @title Export Teams Chat
 * @description Downloads the Microsoft Teams chat you are viewing as a Markdown file,
 *              with pasted images saved alongside it in a .zip.
 * @order 40
 */
(async () => {
  try {
    // 1. Conversation id: Teams rewrites the URL to its bare origin, so read
    //    it from the open chat's compose box / images, else from a deep link.
    const THREAD = /19:[\w.\-]+@[\w.\-]+/;
    const attr = (sel, name) => { const el = document.querySelector(sel); return (el && el.getAttribute(name)) || ''; };
    const convId = (attr('[data-track-thread-id]', 'data-track-thread-id').match(THREAD) ||
                    attr('[data-gallery-id^="gallery-conversation-"]', 'data-gallery-id').match(THREAD) ||
                    decodeURIComponent(location.href).match(THREAD) || [])[0];
    if (!convId) { alert('Open a Teams chat first.'); return; }

    // 2. Skype token: exchange one of the page's cached api.spaces.skype.com
    //    access tokens (current tenant first) and keep the first that can
    //    read this conversation.
    let tid;
    try { tid = JSON.parse(localStorage.getItem('tmp.auth.v1.GLOBAL.User.User')).item.profile.tid; } catch (e) {}
    const now = Date.now() / 1000;
    const bearers = Object.keys(localStorage)
      .filter(k => k.includes('|accesstoken|'))
      .map(k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } })
      .filter(t => t && t.secret && /api\.spaces\.skype\.com/.test(t.target || '') && Number(t.expiresOn) > now)
      .sort((a, b) => (b.realm === tid) - (a.realm === tid));
    if (!bearers.length) { alert('No usable Teams token found — reload Teams and try again.'); return; }

    const view = 'view=msnp24Equivalent|supportsMessageProperties';
    let skypeToken, chatService, firstPage;
    for (const b of bearers) {
      const authz = await fetch('https://teams.microsoft.com/api/authsvc/v1.0/authz', {
        method: 'POST', headers: { Authorization: 'Bearer ' + b.secret }
      });
      if (!authz.ok) continue;
      const j = await authz.json();
      const token = j.tokens && j.tokens.skypeToken;
      const service = j.regionGtms && j.regionGtms.chatService;
      if (!token || !service) continue;
      const res = await fetch(`${service}/v1/users/ME/conversations/${encodeURIComponent(convId)}/messages` +
                              `?${view}&pageSize=200&startTime=1`, { headers: { Authentication: 'skypetoken=' + token } });
      if (!res.ok) continue;
      skypeToken = token; chatService = service; firstPage = await res.json();
      break;
    }
    if (!firstPage) { alert('Could not read this chat. Teams may have changed its API.'); return; }
    const auth = { headers: { Authentication: 'skypetoken=' + skypeToken } };

    // 3. All messages: the API pages backwards from the newest one
    const raw = [];
    for (let page = firstPage, n = 0; page && n < 500; n++) {
      raw.push(...(page.messages || []));
      const next = page._metadata && page._metadata.backwardLink;
      page = next ? await (await fetch(next, auth)).json() : null;
    }
    const msgs = raw.sort((a, b) => new Date(a.originalarrivaltime) - new Date(b.originalarrivaltime));

    // Thread properties (topic, creation time, members) — optional
    let thread = {};
    try {
      const r = await fetch(`${chatService}/v1/threads/${encodeURIComponent(convId)}?view=msnp24Equivalent`, auth);
      if (r.ok) thread = await r.json();
    } catch (e) {}

    // 4. Helpers
    const mriOf = (m) => (m.from || '').split('/').pop();
    const names = {};
    msgs.forEach(m => { if (m.imdisplayname) names[mriOf(m)] = m.imdisplayname; });
    const who = (mri) => names[mri] || 'someone';
    const when = (t) => new Date(t).toLocaleString('sv-SE').slice(0, 16); // YYYY-MM-DD HH:MM, local time
    const list = (v) => {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } }
      return Array.isArray(v) ? v : [];
    };
    // Teams enforces Trusted Types, which blocks DOMParser/innerHTML on plain
    // strings. An XHR 'document' response parses HTML just as inertly
    // (no scripts, no image loads) and is not a Trusted Types sink.
    const html = (s) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([s || ''], { type: 'text/html' }));
      const x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'document';
      x.onload = () => { URL.revokeObjectURL(url); resolve(x.response.body); };
      x.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not parse message HTML')); };
      x.send();
    });
    const bodies = await Promise.all(msgs.map(m => /^(RichText|ThreadActivity)/.test(m.messagetype) ? html(m.content) : null));

    // Inline images are collected here and swapped in after downloading
    const images = [];
    const imageRef = (src) => {
      let i = images.findIndex(im => im.src === src);
      if (i < 0) i = images.push({ src }) - 1;
      return `\u0000IMG${i}\u0000`;
    };

    // 5. Teams message HTML → Markdown
    const wrap = (mark, s) => {
      const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
      return m[2] ? m[1] + mark + m[2] + mark + m[3] : s;
    };
    const toMd = (node, pre) => {
      if (node.nodeType === 3) {
        if (pre) return node.data;
        return /^\s*\n\s*$/.test(node.data) ? '' : node.data.replace(/\s+/g, ' ');
      }
      if (node.nodeType !== 1) return '';
      const kids = () => [...node.childNodes].map(n => toMd(n, pre)).join('');
      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute('itemtype') || '';
      switch (tag) {
        case 'br': return '  \n';
        case 'p': case 'div': case 'section': return '\n\n' + kids().trim() + '\n\n';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          return '\n\n' + '#'.repeat(+tag[1]) + ' ' + kids().trim() + '\n\n';
        case 'strong': case 'b': return wrap('**', kids());
        case 'em': case 'i': return wrap('*', kids());
        case 's': case 'strike': case 'del': return wrap('~~', kids());
        case 'code': return pre ? kids() : wrap('`', kids());
        case 'pre': return '\n\n```\n' + toMd(node, true).replace(/\n$/, '') + '\n```\n\n';
        case 'a': {
          const href = node.getAttribute('href');
          const text = kids().trim();
          if (!href) return text;
          // Teams shortens long URLs in the text to "https://…/prefix…"
          return !text || href.startsWith(text.replace(/…$/, '')) ? `<${href}>` : `[${text}](${href})`;
        }
        case 'img': {
          const alt = node.getAttribute('alt') || '';
          const src = node.getAttribute('src') || '';
          if (/Emoji/.test(type)) return alt;
          if (/AMSImage/.test(type)) return `![${alt || 'image'}](${imageRef(src)})`;
          return /^https?:/.test(src) ? `![${alt}](${src})` : alt;
        }
        case 'blockquote': {
          if (/Reply/.test(type)) {
            const name = (node.querySelector('[itemprop="mri"]') || {}).textContent || '';
            const preview = (node.querySelector('[itemprop="preview"]') || {}).textContent || '';
            return `\n\n> **${name.trim()}:** ${preview.trim()}\n\n`;
          }
          return '\n\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        }
        case 'ul': case 'ol':
          return '\n\n' + [...node.children].filter(li => li.tagName === 'LI').map((li, i) =>
            (tag === 'ol' ? `${i + 1}. ` : '- ') + toMd(li, pre).trim().replace(/\n/g, '\n   ')
          ).join('\n') + '\n\n';
        case 'table': {
          const rows = [...node.querySelectorAll('tr')].map(tr => '| ' + [...tr.children].map(c =>
            toMd(c, pre).trim().replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|')).join(' | ') + ' |');
          if (rows.length) rows.splice(1, 0, rows[0].replace(/[^|]+/g, ' --- '));
          return '\n\n' + rows.join('\n') + '\n\n';
        }
        case 'script': case 'style': return '';
        default: return kids();
      }
    };
    const bodyToMd = (body) => toMd(body).replace(/\n{3,}/g, '\n\n').replace(/(\n\n|  \n) +/g, '$1').trim();

    // 6. Render messages
    const REACTIONS = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😠' };
    const reaction = (key) => {
      const cp = key.match(/^([0-9a-f]{4,6})_/i);
      return REACTIONS[key] || (cp ? String.fromCodePoint(parseInt(cp[1], 16)) : `:${key}:`);
    };

    const renderEvent = (m, x) => {
      const get = (sel) => (x.querySelector(sel) || {}).textContent || '';
      const targets = [...x.querySelectorAll('target')].map(t => who(t.textContent)).join(', ');
      switch (m.messagetype) {
        case 'ThreadActivity/AddMember': return `*${who(get('initiator'))} added ${targets}*`;
        case 'ThreadActivity/DeleteMember': return `*${who(get('initiator'))} removed ${targets}*`;
        case 'ThreadActivity/TopicUpdate': return `*${who(get('initiator'))} renamed the chat to “${get('value')}”*`;
        default: return '';
      }
    };

    const renderMsg = (m, i) => {
      if (/^ThreadActivity\//.test(m.messagetype)) return renderEvent(m, bodies[i]);
      if (!/^(Text|RichText)/.test(m.messagetype)) return '';
      const p = m.properties || {};
      const name = m.imdisplayname || m.fromDisplayNameInToken || mriOf(m);
      const head = `## ${name} · ${when(m.composetime || m.originalarrivaltime)}${p.edittime ? ' *(edited)*' : ''}`;
      if (p.deletetime) return `${head}\n\n*(message deleted)*`;

      const body = bodies[i] ? bodyToMd(bodies[i]) : (m.content || '').trim();
      const files = list(p.files).map(f => `📎 [${f.fileName || f.title || 'file'}](${f.objectUrl || f.fileInfo && f.fileInfo.fileUrl || ''})`);
      const reacts = list(p.emotions).filter(e => (e.users || []).length)
        .map(e => `${reaction(e.key)} ${e.users.length}`);
      const parts = [body, files.join('  \n'), reacts.length ? `*Reactions: ${reacts.join(', ')}*` : '']
        .filter(s => s && s.trim());
      return parts.length ? `${head}\n\n${parts.join('\n\n')}` : '';
    };

    const rendered = msgs.map(renderMsg).filter(Boolean);

    // 7. Download inline images (the skype token authorises the media service).
    //    The message links the 800px "imgo" preview; "imgpsh_fullsize" is the original.
    const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
    const media = { headers: { Authorization: 'skype_token ' + skypeToken } };
    for (const [i, im] of images.entries()) {
      try {
        const full = im.src.replace(/\/views\/imgo$/, '/views/imgpsh_fullsize');
        let r = await fetch(full, media);
        if (!r.ok && full !== im.src) r = await fetch(im.src, media);
        if (!r.ok) throw new Error(r.status);
        const type = (r.headers.get('content-type') || '').split(';')[0];
        im.data = new Uint8Array(await r.arrayBuffer());
        im.path = `images/${String(i + 1).padStart(3, '0')}.${EXT[type] || 'img'}`;
      } catch (e) {
        console.warn('Image download failed, linking it instead:', im.src, e);
        im.path = im.src;
      }
    }
    const saved = images.filter(im => im.data);

    // 8. Assemble the Markdown
    const tp = thread.properties || {};
    const others = [...new Set(msgs.map(m => m.imdisplayname).filter(Boolean))];
    const title = tp.topic || others.join(', ') || 'Teams chat';
    const md = [
      `# ${title}`,
      '',
      `- **Conversation ID:** ${convId}`,
      `- **Created:** ${tp.createdat ? new Date(+tp.createdat).toISOString() : 'unknown'}`,
      `- **Exported:** ${new Date().toISOString()}`,
      `- **Members:** ${(thread.members || []).length || 'unknown'}`,
      `- **Messages:** ${rendered.length}`,
      `- **Images:** ${saved.length}`,
      '',
      '---',
      '',
      rendered.join('\n\n'),
      ''
    ].join('\n').replace(/\u0000IMG(\d+)\u0000/g, (_, i) => images[i].path);

    // 9. Filename: derived from title + short id, editable via prompt()
    const ext = saved.length ? '.zip' : '.md';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const shortId = convId.slice(3).replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const filename = prompt('Save chat as:', `teams_${slug || 'chat'}_${shortId}${ext}`);
    if (!filename) return; // user cancelled
    const base = filename.replace(/\.(zip|md)$/i, '');

    // 10. Build the file: the .md alone, or a stored (uncompressed) zip with images
    let blob;
    if (!saved.length) {
      blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    } else {
      const enc = new TextEncoder();
      const files = [{ name: base + '.md', data: enc.encode(md) },
                     ...saved.map(im => ({ name: im.path, data: im.data }))];
      const CRC = Array.from({ length: 256 }, (_, n) => {
        for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
        return n >>> 0;
      });
      const crc32 = (u8) => { let c = ~0; for (const b of u8) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
      const d = new Date();
      const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const record = (fields) => {
        const v = new DataView(new ArrayBuffer(fields.reduce((s, [n]) => s + n, 0)));
        let o = 0;
        fields.forEach(([n, x]) => { n === 4 ? v.setUint32(o, x, true) : v.setUint16(o, x, true); o += n; });
        return new Uint8Array(v.buffer);
      };
      const out = [], central = [];
      let offset = 0;
      for (const f of files) {
        const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
        // Shared header fields; flag 0x0800 marks UTF-8 filenames, method 0 = stored
        const common = [[2, 20], [2, 0x0800], [2, 0], [2, dosTime], [2, dosDate], [4, crc], [4, size], [4, size], [2, name.length], [2, 0]];
        const local = record([[4, 0x04034b50], ...common]);
        out.push(local, name, f.data);
        central.push(record([[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), name);
        offset += local.length + name.length + size;
      }
      const cdSize = central.reduce((s, p) => s + p.length, 0);
      const end = record([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, cdSize], [4, offset], [2, 0]]);
      blob = new Blob([...out, ...central, end], { type: 'application/zip' });
    }

    // 11. Download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = base + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {
    alert('Export failed: ' + e.message);
    console.error(e);
  }
})();
