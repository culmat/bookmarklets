/**
 * Collibra AI Use Case → HTML + Markdown export bookmarklet
 *
 * Run it on an asset page of a Collibra Data Intelligence Platform instance
 * (URL like https://<tenant>.collibra.com/asset/<uuid>). It is built for the
 * "AI Use Case" asset type but exports any asset type generically.
 *
 * It uses Collibra's own REST 2.0 and GraphQL APIs with the session the page
 * already holds — no DOM scraping, nothing typed in — and collects in one go:
 *   - the asset page as configured (Overview + every section such as Business
 *     Context, Compliance …) with all attribute values and relation tables,
 *   - the assessments attached to the asset (every question with its answer,
 *     status, owner, submission data),
 *   - lifecycle phases and lifecycle activities, responsibilities (incl.
 *     inherited), comments, attachments (downloaded), the change history,
 *   - the diagram view the asset page embeds, as node/edge data drawn into an
 *     SVG and as Mermaid source. If you run it on the Diagram tab, the diagram
 *     rendered on screen is captured as well.
 * Not covered: the Pictures tab (no readable API) and other diagram views.
 *
 * Side effect: to read a diagram view that is not your current one, the
 * bookmarklet switches your current diagram view and switches it back.
 *
 * The filename prompt decides the format:
 *   collibra_<slug>_<short-id>.zip   (default) HTML + Markdown + attachments/ +
 *                                    diagram SVG + raw.json with the API data
 *   collibra_….html                  one self-contained HTML file — open it in
 *                                    any browser, "Print → Save as PDF" for a PDF
 *   collibra_….md                    Markdown only (diagram as Mermaid)
 *
 * @title Export Collibra AI Use Case
 * @description Saves the Collibra AI Use Case you are viewing — all sections,
 *              assessments, lifecycle, responsibilities, comments, attachments
 *              and diagram — as a self-contained HTML page plus Markdown.
 * @order 50
 */
(async () => {
  try {
    // 1. Asset id from the URL, API helpers, CSRF token
    const m = location.pathname.match(/\/asset\/([0-9a-f-]{36})/i);
    if (!m) { alert('Open a Collibra asset page first (URL must look like /asset/<uuid>).'); return; }
    const assetId = m[1];
    const origin = location.origin;
    const AI_USE_CASE_TYPE = '00000000-0000-0000-0000-000000031401';

    const rest = async (path) => {
      const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`);
      return r.json();
    };
    let csrf = '';
    try { csrf = (await rest('/rest/2.0/auth/sessions/current?include=csrfToken')).csrfToken || ''; } catch (e) {}
    const gql = async (query, variables) => {
      const headers = { 'content-type': 'application/json' };
      if (csrf) headers['x-csrf-token'] = csrf;
      const r = await fetch('/graphql', { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ query, variables }) });
      if (!r.ok) throw new Error('GraphQL → HTTP ' + r.status);
      const j = await r.json();
      if (j.errors && j.errors.length) console.warn('GraphQL errors', j.errors);
      if (!j.data) throw new Error('GraphQL: ' + JSON.stringify(j.errors || j));
      return j.data;
    };
    // Optional data: a failure (e.g. missing permission) degrades to null
    const optional = (p) => p.then(v => v, e => { console.warn('Skipped:', e); return null; });
    const bare = (id) => String(id || '').replace(/^[A-Za-z]+:/, ''); // "Asset:<uuid>" → "<uuid>"
    const raw = {};

    // 2. Asset core, breadcrumb and the page layout with attribute values
    const asset = await rest(`/rest/2.0/assets/${assetId}`);
    raw.asset = asset;
    const ELEMENT = `
      __typename
      ... on AssetPageCharacteristic { characteristicTypeAssignedToAsset { __typename
        ... on AttributeTypeAssignedToAsset {
          assignedAttributeType { attributeType { id name __typename ... on StringAttributeType { stringType } } }
          attributes { __typename ... on StringAttribute { stringValue } ... on BooleanAttribute { booleanValue }
            ... on DateAttribute { longValue } ... on NumericAttribute { doubleValue }
            ... on MultiValueListAttribute { valueList } ... on SingleValueListAttribute { stringValue } } }
        ... on RelationTypeAssignedToAsset { instanceRoleDirection assignedRelationType { relationType {
          id role coRole sourceType { id name } targetType { id name } } } }
        ... on DerivedRelationTypeAssignedToAsset { instanceRoleDirection assignedDerivedRelationType { derivedRelationType {
          id role coRole sourceType { name } targetType { name } } } }
        ... on ComplexRelationTypeAssignedToAsset { assignedComplexRelationType { complexRelationType { id name } } } } }
      ... on AssetPageWidget { widgetIdentifier widgetConfiguration }`;
    const [breadcrumb, pageData, relSrc, relTgt] = await Promise.all([
      optional(rest(`/rest/2.0/assets/${assetId}/breadcrumb`)),
      gql(`query($id: ID!) { api { asset(id: $id) { assetPage { elements { ${ELEMENT} } sections { name expanded elements { ${ELEMENT} } } } } } }`,
          { id: 'Asset:' + assetId }),
      optional(rest(`/rest/2.0/relations?sourceId=${assetId}&limit=500`)),
      optional(rest(`/rest/2.0/relations?targetId=${assetId}&limit=500`))
    ]);
    raw.breadcrumb = breadcrumb; raw.assetPage = pageData; raw.relations = { asSource: relSrc, asTarget: relTgt };
    const page = pageData.api.asset.assetPage;
    const pageSections = [{ name: 'Overview', elements: page.elements || [] }, ...(page.sections || [])];

    // 3. Related assets: group relation instances by type + direction, then
    //    fetch type/status and short attributes of each related asset (cap 50)
    const relIndex = {}; // "<typeId>|TO_TARGET" → [asset ids]
    (relSrc && relSrc.results || []).forEach(r => (relIndex[`${r.type.id}|TO_TARGET`] = relIndex[`${r.type.id}|TO_TARGET`] || []).push(r.target.id));
    (relTgt && relTgt.results || []).forEach(r => (relIndex[`${r.type.id}|TO_SOURCE`] = relIndex[`${r.type.id}|TO_SOURCE`] || []).push(r.source.id));
    const relatedIds = [...new Set(Object.values(relIndex).flat())].slice(0, 50);
    const related = {};
    await Promise.all(relatedIds.map(async (id) => {
      const a = await optional(rest(`/rest/2.0/assets/${id}`));
      const attrs = a ? await optional(rest(`/rest/2.0/attributes?assetId=${id}&limit=500`)) : null;
      if (a) related[id] = { asset: a, attributes: attrs ? attrs.results : [] };
    }));
    raw.relatedAssets = related;

    // 4. Assessments, lifecycle, responsibilities, comments, attachments, history
    const STATUS_IDS = `query($id: ID!) { api { asset(id: $id) { status { id name } assignment { lifecycleDefinition { phases { name lifecycleStatuses { status { id name } } } } } } } }`;
    const lifecycle = await optional(gql(STATUS_IDS, { id: 'Asset:' + assetId }));
    const phases = (((lifecycle || {}).api || {}).asset || {}).assignment;
    const phaseList = phases && phases.lifecycleDefinition ? phases.lifecycleDefinition.phases : [];
    const statusIds = phaseList.flatMap(p => p.lifecycleStatuses.map(s => bare(s.status.id)));
    const ACTIVITIES = `query($input: FindLifecycleActivitiesRequest) { api { experimentalLifecycleActivities(input: $input) { edges { node { __typename
      ... on AssessmentActivity { name activityStatus lastModifiedOn assessmentId owner { firstName lastName } assignees { __typename ... on User { firstName lastName } ... on UserGroup { name } } assessmentReview { id } }
      ... on SignOff { name activityStatus lastModifiedOn description lastModifiedBy { firstName lastName } }
      ... on SmartCheckActivity { activityStatus smartCheck { state definition { name } } } } } } } }`;
    const RESPONSIBILITIES = `query($id: ID!) { api { asset(id: $id) { responsibilities(includeInherited: true, first: 300) { edges { node {
      role { name } owner { __typename ... on User { firstName lastName emailAddress } ... on UserGroup { name } }
      resource { __typename ... on Asset { id name } ... on Domain { id name } ... on Community { id name } } } } } } } }`;
    const [assessments, activities, responsibilities, comments, attachments, history] = await Promise.all([
      optional(rest(`/rest/assessments/v1/assessments?assetId=${assetId}`)),
      statusIds.length ? optional(gql(ACTIVITIES, { input: { assetId, statusIds } })) : null,
      optional(gql(RESPONSIBILITIES, { id: 'Asset:' + assetId })),
      optional(rest(`/rest/2.0/comments?baseResourceId=${assetId}&limit=500`)),
      optional(rest(`/rest/2.0/attachments?baseResourceId=${assetId}&limit=500`)),
      optional(rest(`/rest/2.0/activities?contextId=${assetId}&limit=200`))
    ]);
    Object.assign(raw, { lifecycle, assessments, activities, responsibilities, comments, attachments, history });

    // User names for ids the REST API returns bare (comment authors)
    const userCache = {};
    const userName = async (id) => {
      if (!id) return '';
      if (!(id in userCache)) {
        const u = await optional(rest(`/rest/2.0/users/${id}`));
        userCache[id] = u ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userName : id;
      }
      return userCache[id];
    };

    // 5. Diagram: the view the page's Diagram widget shows, via the user's
    //    current diagram view (switched and restored if it differs)
    const typeId = asset.type.id;
    const widget = pageSections.flatMap(s => s.elements).find(e => e.__typename === 'AssetPageWidget' && e.widgetIdentifier === 'Diagram');
    let widgetViewId = '';
    try { widgetViewId = JSON.parse(widget.widgetConfiguration).diagramViewId; } catch (e) {}
    const VIEW = `query($t: ID!, $a: ID!) { api { currentUser { currentView(resourceId: $t, location: "diagram", type: "DIAGRAM") { resultDiagram(assetId: $a) view { id name description } } } } }`;
    const TOUCH = `mutation($input: TouchViewRequest!) { touchView(input: $input) { currentUser { id } } }`;
    const touch = (viewId) => gql(TOUCH, { input: { id: viewId, resourceId: 'AssetType:' + typeId } });
    let diagram = null;
    try {
      const tv = { t: 'AssetType:' + typeId, a: 'Asset:' + assetId };
      let cur = (await gql(VIEW, tv)).api.currentUser.currentView;
      const curId = cur && cur.view ? cur.view.id : '';
      if (widgetViewId && widgetViewId !== curId) {
        await touch(widgetViewId);
        cur = (await gql(VIEW, tv)).api.currentUser.currentView;
        if (curId) await optional(touch(curId));
      }
      if (cur && cur.resultDiagram) {
        const d = JSON.parse(cur.resultDiagram);
        diagram = { viewName: cur.view ? cur.view.name : 'Diagram', nodes: d.nodes || [], edges: d.edges || [] };
      }
    } catch (e) { console.warn('Diagram skipped:', e); }
    raw.diagram = diagram;
    // Rendered diagram on screen (only on the Diagram tab): serialise the main
    // canvas (the largest yFiles SVG; a smaller one is the overview panel)
    let capturedSvg = '';
    const live = [...document.querySelectorAll('svg.yfiles-canvascomponent-svg')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (live && live.clientWidth > 200) {
      try {
        // Content bounds in the SVG's own coordinate space: union of the drawn
        // shapes' screen rectangles mapped back through the root's CTM (yFiles
        // pans/zooms with transforms that getBBox() would not reflect)
        const inv = live.getScreenCTM().inverse();
        const pt = (x, y) => { const p = live.createSVGPoint(); p.x = x; p.y = y; return p.matrixTransform(inv); };
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        live.querySelectorAll('rect,path,text,circle,ellipse,line,polygon,polyline,image').forEach(el => {
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) return;
          const a = pt(r.left, r.top), b = pt(r.right, r.bottom);
          x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, b.x); y1 = Math.max(y1, b.y);
        });
        if (!isFinite(x0)) throw new Error('empty diagram');
        const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const c = live.cloneNode(true);
        c.removeAttribute('style');
        c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        c.setAttribute('viewBox', `${box.x - 10} ${box.y - 10} ${box.width + 20} ${box.height + 20}`);
        c.setAttribute('width', Math.ceil(box.width + 20)); c.setAttribute('height', Math.ceil(box.height + 20));
        c.setAttribute('font-family', getComputedStyle(live).fontFamily);
        [...c.querySelectorAll('script')].forEach(s => s.remove());
        capturedSvg = c.outerHTML;
      } catch (e) { console.warn('SVG capture failed:', e); }
    }

    // 6. Attachment files
    const files = []; // { name, data } for the zip
    const safeName = (s) => (s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
    const attList = (attachments && attachments.results || []).map((a, i) => ({
      id: a.id, name: a.fileName || a.name || `attachment-${i + 1}`, size: a.size, mime: a.mimeType || '', createdOn: a.createdOn,
      path: ''
    }));
    const usedNames = new Set();
    for (const a of attList) {
      try {
        const r = await fetch(`/rest/2.0/attachments/${a.id}/file`, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let name = safeName(a.name), n = 1;
        while (usedNames.has(name)) name = name.replace(/(\.[^.]*)?$/, `-${++n}$1`);
        usedNames.add(name);
        a.path = 'attachments/' + name;
        files.push({ name: a.path, data: new Uint8Array(await r.arrayBuffer()) });
      } catch (e) { console.warn('Attachment download failed, linking it instead:', a.name, e); }
    }

    // 7. Formatting helpers and the shared document model
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // Timestamps come as epoch ms (REST) or ISO strings (assessments API)
    const date = (v) => { const d = new Date(/^\d+$/.test(String(v)) ? +v : v); return isNaN(d) ? null : d; };
    const ymd = (v) => { const d = v ? date(v) : null; return d ? d.toLocaleDateString('sv-SE') : ''; };
    const dt = (v) => { const d = v ? date(v) : null; return d ? d.toLocaleString('sv-SE').slice(0, 16) : ''; };
    const num = (v) => v == null ? '' : (Number.isInteger(+v) ? String(+v) : String(+v));
    const person = (u) => !u ? '' : u.__typename === 'UserGroup' ? `${u.name} (group)` : [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.userName || u.emailAddress || '';
    const title = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Rich text: keep a small set of tags, drop every attribute but safe hrefs
    const KEEP = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                          'blockquote', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr', 'img']);
    const sanitize = (html) => {
      if (html == null || html === '') return '';
      const doc = new DOMParser().parseFromString(String(html), 'text/html');
      const walk = (node) => {
        [...node.childNodes].forEach(ch => {
          if (ch.nodeType !== 1) { if (ch.nodeType !== 3) ch.remove(); return; }
          const tag = ch.tagName.toLowerCase();
          if (/^(script|style|iframe|object|embed|svg|form|input|button)$/.test(tag)) { ch.remove(); return; }
          walk(ch);
          if (!KEEP.has(tag)) { ch.replaceWith(...ch.childNodes); return; }
          [...ch.attributes].forEach(at => {
            const keep = (tag === 'a' && at.name === 'href' && /^(https?:|mailto:|\/|#)/i.test(at.value.trim())) ||
                         (tag === 'img' && at.name === 'src' && /^(https?:|data:image\/)/i.test(at.value.trim())) ||
                         (tag === 'img' && at.name === 'alt') || (/^t[dh]$/.test(tag) && /^(col|row)span$/.test(at.name));
            if (!keep) ch.removeAttribute(at.name);
          });
          if (tag === 'a' && ch.getAttribute('href') && ch.getAttribute('href').startsWith('/')) ch.setAttribute('href', origin + ch.getAttribute('href'));
        });
      };
      walk(doc.body);
      return doc.body.innerHTML.trim();
    };
    const textOf = (html) => { const d = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html'); return d.body.textContent.replace(/\s+/g, ' ').trim(); };

    // Attribute value → { valueType, value }
    const attrValue = (type, attrs) => {
      const t = type.__typename;
      if (!attrs.length) return null;
      if (t === 'MultiValueListAttributeType') { const v = attrs.flatMap(a => a.valueList || []); return v.length ? { valueType: 'list', value: v } : null; }
      if (t === 'SingleValueListAttributeType') { const v = attrs.map(a => a.stringValue).filter(Boolean); return v.length ? { valueType: 'list', value: v } : null; }
      if (t === 'BooleanAttributeType') { const a = attrs.find(x => x.booleanValue != null); return a ? { valueType: 'bool', value: a.booleanValue } : null; }
      if (t === 'DateAttributeType') { const a = attrs.find(x => x.longValue != null); return a ? { valueType: 'date', value: ymd(a.longValue) } : null; }
      if (t === 'NumericAttributeType') { const a = attrs.find(x => x.doubleValue != null); return a ? { valueType: 'number', value: num(a.doubleValue) } : null; }
      const s = attrs.map(a => a.stringValue).filter(v => v != null && String(v).trim() !== '');
      if (!s.length) return null;
      return type.stringType === 'RICH_TEXT' ? { valueType: 'rich', value: sanitize(s.join('<br>')) } : { valueType: 'text', value: s.join('\n') };
    };
    // REST attribute (related assets) → short display string, or '' if long/empty.
    // A value that is just a link (e.g. "View details in assessment app") becomes its URL.
    const restAttrShort = (a) => {
      const v = a.value;
      if (v == null || v === '') return '';
      if (a.resourceType === 'DateAttribute') return ymd(v);
      if (a.resourceType === 'BooleanAttribute') return v ? 'Yes' : 'No';
      if (Array.isArray(v)) return v.join(', ');
      const link = String(v).match(/<a\s[^>]*href="([^"]+)"/i);
      if (link) return link[1].startsWith('/') ? origin + link[1] : link[1];
      const s = textOf(String(v));
      return s.length <= 100 ? s : '';
    };

    const sections = pageSections.map(sec => {
      const blocks = [];
      let empty = 0;
      sec.elements.forEach(el => {
        if (el.__typename === 'AssetPageWidget') {
          if (el.widgetIdentifier === 'ProgressTracker') blocks.push({ kind: 'lifecycle' });
          else if (el.widgetIdentifier === 'Diagram') blocks.push({ kind: 'diagram' });
          return;
        }
        const c = el.characteristicTypeAssignedToAsset;
        if (!c) return;
        if (c.__typename === 'AttributeTypeAssignedToAsset') {
          const type = c.assignedAttributeType.attributeType;
          const v = attrValue(type, c.attributes || []);
          if (v) blocks.push({ kind: 'attr', label: type.name, ...v }); else empty++;
        } else if (c.__typename === 'RelationTypeAssignedToAsset') {
          const rt = c.assignedRelationType.relationType;
          const dir = c.instanceRoleDirection;
          const label = dir === 'TO_TARGET' ? `${rt.role} ${rt.targetType.name}` : `${rt.coRole} ${rt.sourceType.name}`;
          const ids = relIndex[`${bare(rt.id)}|${dir}`] || [];
          const assets = ids.map(id => {
            const r = related[id];
            const extra = {};
            if (r) r.attributes.forEach(a => { const s = restAttrShort(a); if (s) extra[a.type.name] = s; });
            return { id, name: r ? r.asset.name : id, type: r ? r.asset.type.name : '', status: r && r.asset.status ? r.asset.status.name : '', extra };
          });
          if (assets.length) blocks.push({ kind: 'relation', label, assets }); else empty++;
        } else if (c.__typename === 'DerivedRelationTypeAssignedToAsset' || c.__typename === 'ComplexRelationTypeAssignedToAsset') {
          empty++; // not exported: no per-asset instance API for derived/complex relations
        }
      });
      return { name: sec.name, blocks, empty };
    }).filter(s => s.blocks.length || s.empty);

    const lifecycleModel = {
      phases: phaseList.map(p => ({ name: p.name, statuses: p.lifecycleStatuses.map(s => s.status.name) })),
      current: asset.status ? asset.status.name : '',
      activities: ((((activities || {}).api || {}).experimentalLifecycleActivities || {}).edges || []).map(e => e.node).map(n => ({
        name: n.name || (n.smartCheck && n.smartCheck.definition ? 'Smart check: ' + n.smartCheck.definition.name : n.__typename),
        status: title(n.activityStatus || (n.smartCheck && n.smartCheck.state) || ''),
        owner: person(n.owner || n.lastModifiedBy),
        assignees: (n.assignees || []).map(person).filter(Boolean).join(', '),
        updated: dt(n.lastModifiedOn),
        href: n.assessmentReview ? `${origin}/asset/${bare(n.assessmentReview.id)}` : n.assessmentId ? `${origin}/assessments/conduct?id=${n.assessmentId}` : ''
      }))
    };

    const answerModel = (ans) => {
      if (!ans || ans.value == null || ans.value === '') return null;
      switch (ans.type) {
        case 'HTML': return { type: 'rich', value: sanitize(ans.value) };
        case 'BOOLEAN': return { type: 'bool', value: !!ans.value };
        case 'ITEMS': return { type: 'list', value: (ans.value || []).map(v => v.value || v.id) };
        case 'ASSETS': return { type: 'assets', value: (ans.value || []).map(v => ({ id: v.id, name: v.name })) };
        case 'DATE': return { type: 'date', value: String(ans.value) };
        case 'NUMBER': return { type: 'number', value: num(ans.value) };
        default: return { type: 'text', value: String(ans.value) }; // TEXT, EXPRESSION, …
      }
    };
    const assessmentModel = (assessments && assessments.results || [])
      .slice().sort((a, b) => (b.lastModifiedOn || 0) - (a.lastModifiedOn || 0))
      .map(a => ({
        id: a.id, name: a.name, template: a.template ? a.template.name : a.name, version: a.template ? a.template.version : '',
        status: a.status || '', owner: a.owner ? a.owner.name : '', submittedBy: a.submittedBy ? a.submittedBy.name : '',
        submittedOn: a.submittedOn ? ymd(a.submittedOn) : '', modified: dt(a.lastModifiedOn),
        reviewId: a.assessmentReview ? a.assessmentReview.id : '',
        href: `${origin}/assessments/${a.status === 'DRAFT' ? 'conduct' : 'instance'}?id=${a.id}`,
        questions: (a.content || []).map(q => ({
          text: /\[type the question here/i.test(textOf(q.name)) ? '' : sanitize(q.name),
          description: sanitize(q.description), answer: answerModel(q.answer)
        }))
      }));

    const commentModel = [];
    for (const c of (comments && comments.results || []).slice().sort((a, b) => (a.createdOn || 0) - (b.createdOn || 0))) {
      commentModel.push({ author: await userName(c.createdBy), createdOn: dt(c.createdOn), html: sanitize(c.content) });
    }
    const AFFECTED = { TE: 'Asset', RE: 'Relation', ME: 'Responsibility', WI: 'Workflow', CO: 'Comment', AT: 'Attachment' };
    const historyModel = (history && history.results || []).map(h => {
      let d = {};
      try { d = JSON.parse(h.description); } catch (e) { d = { new: h.description }; }
      const trunc = (v) => {
        if (typeof v === 'object' && v) v = v.name || JSON.stringify(v); // { name, id, type } records
        if (/^\d{12,13}$/.test(String(v))) return ymd(v); // date attributes are logged as epoch ms
        const s = textOf(v == null ? '' : v);
        return s.length > 200 ? s.slice(0, 200) + '…' : s;
      };
      const af = d.affected || {};
      const field = d.field || (/^(RE|ME)[0-9a-f-]{36}$/i.test(af.name || '') ? AFFECTED[af.type] : af.name) || AFFECTED[af.type] || '';
      return { when: dt(h.timestamp), who: h.user ? h.user.userName : '', action: title(h.activityType), field, from: trunc(d.old), to: trunc(d.new) };
    });

    const doc = {
      title: asset.displayName || asset.name, url: `${origin}/asset/${assetId}`, id: assetId,
      type: asset.type.name, status: asset.status ? asset.status.name : '', domain: asset.domain ? asset.domain.name : '',
      breadcrumb: (breadcrumb || []).map(b => b.name), created: dt(asset.createdOn), modified: dt(asset.lastModifiedOn), exported: dt(Date.now()),
      generic: typeId !== AI_USE_CASE_TYPE,
      responsibilities: ((((responsibilities || {}).api || {}).asset || {}).responsibilities || { edges: [] }).edges.map(e => e.node).map(n => ({
        role: n.role.name, owner: person(n.owner), email: n.owner.emailAddress || '',
        inheritedFrom: n.resource && n.resource.__typename !== 'Asset' ? `${n.resource.__typename} ${n.resource.name}` : ''
      })),
      sections, lifecycle: lifecycleModel, assessments: assessmentModel, diagram, capturedSvg,
      comments: commentModel, attachments: attList, history: historyModel
    };

    // 8. Diagram renderers: a layered SVG drawn from the node/edge data, and Mermaid
    const diagramGraph = (d) => {
      const canon = {}, nodes = [], byRes = {};
      d.nodes.forEach(n => {
        const a = n.asset || n; const key = a.resourceId || a.id;
        if (!byRes[key]) { byRes[key] = nodes.length; nodes.push({ id: key, name: a.name || '', type: a.type ? a.type.name : '', color: a.type && a.type.color || '#6b7280', status: (a.fields || []).map(f => f.status && f.status.name).filter(Boolean)[0] || '' }); }
        canon[a.id] = byRes[key];
      });
      const seen = new Set();
      const edges = d.edges.map(e => ({ from: canon[e.from], to: canon[e.to], label: e.originalLabel || e.label || '' }))
        .filter(e => e.from != null && e.to != null && e.from !== e.to && !seen.has(`${e.from}|${e.to}|${e.label}`) && seen.add(`${e.from}|${e.to}|${e.label}`));
      return { nodes, edges };
    };
    const drawDiagramSvg = (d, rootId) => {
      const { nodes, edges } = diagramGraph(d);
      if (!nodes.length) return '';
      const W = 200, H = 56, CG = 130, RG = 24, PAD = 20;
      const adj = nodes.map(() => new Set());
      edges.forEach(e => { adj[e.from].add(e.to); adj[e.to].add(e.from); });
      const layer = nodes.map(() => -1);
      const start = Math.max(0, nodes.findIndex(n => n.id === rootId));
      const queue = [start]; layer[start] = 0;
      while (queue.length) { const i = queue.shift(); adj[i].forEach(j => { if (layer[j] < 0) { layer[j] = layer[i] + 1; queue.push(j); } }); }
      const maxLayer = Math.max(0, ...layer);
      layer.forEach((l, i) => { if (l < 0) layer[i] = maxLayer + 1; });
      const cols = [];
      layer.forEach((l, i) => (cols[l] = cols[l] || []).push(i));
      const pos = [];
      const totalH = Math.max(...cols.map(c => c.length)) * (H + RG) - RG;
      cols.forEach((c, l) => { const h = c.length * (H + RG) - RG; c.forEach((i, r) => { pos[i] = { x: PAD + l * (W + CG), y: PAD + (totalH - h) / 2 + r * (H + RG) }; }); });
      const width = PAD * 2 + cols.length * W + (cols.length - 1) * CG, height = PAD * 2 + totalH;
      const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
      const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="12">`,
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7280"/></marker></defs>'];
      // Labels sit near the end of the edge that is not shared, so fan-in /
      // fan-out edges do not stack their labels on the same spot
      const inDeg = {}, outDeg = {};
      edges.forEach(e => { inDeg[e.to] = (inDeg[e.to] || 0) + 1; outDeg[e.from] = (outDeg[e.from] || 0) + 1; });
      edges.forEach(e => {
        const a = pos[e.from], b = pos[e.to], fwd = layer[e.to] > layer[e.from], same = layer[e.to] === layer[e.from];
        const sx = same ? a.x + W : fwd ? a.x + W : a.x, sy = a.y + H / 2;
        const tx = same ? b.x + W : fwd ? b.x : b.x + W, ty = b.y + H / 2;
        const dx = same ? 60 : Math.max(40, Math.abs(tx - sx) / 2) * (fwd ? 1 : -1);
        const c1x = sx + dx, c2x = tx - (same ? -60 : dx);
        const path = `M${sx},${sy} C${c1x},${sy} ${c2x},${ty} ${tx},${ty}`;
        const t = inDeg[e.to] > 1 && outDeg[e.from] === 1 ? 0.3 : outDeg[e.from] > 1 && inDeg[e.to] === 1 ? 0.7 : 0.5;
        const bez = (p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
        const mx = bez(sx, c1x, c2x, tx), my = bez(sy, sy, ty, ty), lw = e.label.length * 6.2 + 10;
        out.push(`<path d="${path}" fill="none" stroke="#6b7280" stroke-width="1.5" marker-end="url(#arrow)"/>`);
        if (e.label) out.push(`<rect x="${mx - lw / 2}" y="${my - 9}" width="${lw}" height="18" rx="4" fill="#fff" stroke="#e5e7eb"/><text x="${mx}" y="${my + 4}" text-anchor="middle" fill="#374151" font-size="11">${esc(e.label)}</text>`);
      });
      nodes.forEach((n, i) => {
        const p = pos[i], root = n.id === rootId;
        out.push(`<a href="${esc(origin + '/asset/' + n.id)}"><title>${esc(n.name)} (${esc(n.type)}${n.status ? ' · ' + esc(n.status) : ''})</title>`,
          `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="${esc(n.color)}" fill-opacity="0.12" stroke="${esc(n.color)}" stroke-width="${root ? 3 : 1.5}"/>`,
          `<text x="${p.x + 12}" y="${p.y + 24}" fill="#111827" font-weight="${root ? 700 : 600}">${esc(cut(n.name, 28))}</text>`,
          `<text x="${p.x + 12}" y="${p.y + 42}" fill="#4b5563" font-size="11">${esc(cut(n.type + (n.status ? ' · ' + n.status : ''), 32))}</text></a>`);
      });
      out.push('</svg>');
      return out.join('');
    };
    const mermaidOf = (d) => {
      const { nodes, edges } = diagramGraph(d);
      const q = (s) => String(s).replace(/"/g, '#quot;');
      return ['flowchart LR',
        ...nodes.map((n, i) => `  n${i}["${q(n.name)}<br/>(${q(n.type)}${n.status ? ' · ' + q(n.status) : ''})"]`),
        ...edges.map(e => `  n${e.from} -->|${q(e.label).replace(/\|/g, '/')}| n${e.to}`)].join('\n');
    };
    const drawnSvg = diagram ? drawDiagramSvg(diagram, assetId) : '';
    const svgName = diagram ? `diagram-${(diagram.viewName || 'view').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'view'}.svg` : '';

    // 9. HTML renderer (self-contained, prints to PDF)
    const toHtml = (d, attachmentHref) => {
      const badge = (s) => { const k = /approved|completed|accepted/i.test(s) ? 'ok' : /submitted|monitoring|development|in.?progress|review/i.test(s) ? 'info' : /rejected|archived|retired|obsolete/i.test(s) ? 'bad' : 'muted'; return `<span class="badge ${k}">${esc(s)}</span>`; };
      const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const table = (head, rows) => rows.length ? `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
      const value = (b) => {
        switch (b.valueType) {
          case 'rich': return `<div class="rich">${b.value}</div>`;
          case 'list': return `<div class="chips">${b.value.map(v => `<span class="chip">${esc(v)}</span>`).join('')}</div>`;
          case 'bool': return b.value ? '<span class="pill yes">Yes</span>' : '<span class="pill no">No</span>';
          default: return `<div class="text">${esc(b.value)}</div>`;
        }
      };
      const relation = (b) => {
        const extras = [...new Set(b.assets.flatMap(a => Object.keys(a.extra)))].slice(0, 6);
        return `<h3>${esc(b.label)}</h3>` + table(['Name', 'Type', 'Status', ...extras],
          b.assets.map(a => [`<a href="${esc(origin + '/asset/' + a.id)}">${esc(a.name)}</a>`, esc(a.type), a.status ? badge(a.status) : '', ...extras.map(k => esc(a.extra[k] || ''))]));
      };
      const lifecycle = (l) => `<div class="phases">${l.phases.map(p => `<div class="phase"><div class="phase-name">${esc(p.name)}</div>${p.statuses.map(s => `<span class="step${s === l.current ? ' current' : ''}">${esc(s)}</span>`).join('')}</div>`).join('')}</div>` +
        (l.activities.length ? `<h3>Activities</h3>` + table(['Status', 'Activity', 'Owner', 'Assignees', 'Last update'],
          l.activities.map(a => [badge(a.status), a.href ? `<a href="${esc(a.href)}">${esc(a.name)}</a>` : esc(a.name), esc(a.owner), esc(a.assignees), esc(a.updated)])) : '<p class="muted">No lifecycle activities.</p>');
      const diagramHtml = () => {
        if (!d.diagram && !d.capturedSvg) return '<p class="muted">No diagram available.</p>';
        return `<div class="diagram">${d.capturedSvg || drawnSvg}</div>` +
          (d.capturedSvg && drawnSvg ? `<details><summary>Schematic view</summary><div class="diagram">${drawnSvg}</div></details>` : '') +
          (d.diagram ? `<details class="noprint"><summary>Mermaid source</summary><pre>${esc(mermaidOf(d.diagram))}</pre></details>` : '');
      };
      const answer = (a) => {
        if (!a) return '<span class="pill none">Unanswered</span>';
        switch (a.type) {
          case 'rich': return `<div class="rich">${a.value}</div>`;
          case 'bool': return a.value ? '<span class="pill yes">Yes</span>' : '<span class="pill no">No</span>';
          case 'list': return `<div class="chips">${a.value.map(v => `<span class="chip">${esc(v)}</span>`).join('')}</div>`;
          case 'assets': return `<div class="chips">${a.value.map(v => `<a class="chip" href="${esc(origin + '/asset/' + v.id)}">${esc(v.name)}</a>`).join('')}</div>`;
          default: return `<div class="text">${esc(a.value)}</div>`;
        }
      };
      const assessment = (a) => `<details open class="assessment"><summary><span class="a-title">${esc(a.template)}${a.version ? ` <span class="muted">v${esc(a.version)}</span>` : ''}</span> ${badge(a.status)}</summary>
        <p class="meta">Owner: ${esc(a.owner || '—')}${a.submittedBy ? ` · Submitted by ${esc(a.submittedBy)} on ${esc(a.submittedOn)}` : ''} · Last change ${esc(a.modified)} · <a href="${esc(a.href)}">Open in Collibra</a>${a.reviewId ? ` · <a href="${esc(origin + '/asset/' + a.reviewId)}">Assessment review</a>` : ''}</p>
        ${a.questions.map(q => q.text ? `<div class="q"><div class="q-text">${q.text}</div>${q.description ? `<div class="q-desc">${q.description}</div>` : ''}<div class="q-answer">${answer(q.answer)}</div></div>`
                                        : `<div class="q intro">${q.answer && q.answer.type === 'rich' ? q.answer.value : esc(q.answer ? q.answer.value : '')}</div>`).join('')}
      </details>`;
      const navItems = [...d.sections.map(s => [slug(s.name), s.name]), ['assessments', 'Assessments'], ['diagram', 'Diagram'], ['comments', 'Comments'], ['attachments', 'Attachments'], ['history', 'History']];
      const sectionHtml = (s) => `<section id="${slug(s.name)}"><h2>${esc(s.name)}</h2>${s.blocks.map(b => {
        if (b.kind === 'attr') return `<div class="row"><div class="label">${esc(b.label)}</div><div class="val">${value(b)}</div></div>`;
        if (b.kind === 'relation') return relation(b);
        if (b.kind === 'lifecycle') return lifecycle(d.lifecycle);
        if (b.kind === 'diagram') return `<p><a href="#diagram">See the diagram below.</a></p>`;
        return '';
      }).join('')}${s.empty ? `<p class="muted small">${s.empty} empty field${s.empty > 1 ? 's' : ''} omitted.</p>` : ''}</section>`;
      const css = `
        :root { --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#f9fafb; --accent:#0b5fff; }
        * { box-sizing:border-box } body { margin:0; font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:#fff }
        a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
        header { padding:28px 32px 20px; border-bottom:1px solid var(--line); background:var(--bg) }
        header h1 { margin:0 0 8px; font-size:28px } .crumbs { color:var(--muted); font-size:13px } .meta { color:var(--muted); font-size:13px; margin:6px 0 }
        .tools { margin-top:12px; display:flex; gap:10px; flex-wrap:wrap } button { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:6px; background:#fff; cursor:pointer }
        .layout { display:grid; grid-template-columns:240px 1fr; max-width:1280px; margin:0 auto } nav { position:sticky; top:0; align-self:start; max-height:100vh; overflow:auto; padding:24px 16px; border-right:1px solid var(--line); font-size:14px }
        nav a { display:block; padding:4px 8px; color:var(--ink); border-radius:4px } nav a:hover { background:var(--bg) } main { padding:8px 32px 48px; min-width:0 }
        section { padding:20px 0; border-bottom:1px solid var(--line) } h2 { font-size:20px; margin:8px 0 14px } h3 { font-size:15px; margin:18px 0 8px; color:#374151 }
        .row { display:grid; grid-template-columns:260px 1fr; gap:12px; padding:7px 0; border-top:1px solid #f3f4f6 } .row:first-of-type { border-top:0 } .label { color:var(--muted); font-size:13px; padding-top:2px }
        .text { white-space:pre-line } .rich p:first-child { margin-top:0 } .rich p:last-child { margin-bottom:0 } .rich img { max-width:100% } .rich h1, .rich h2, .rich h3, .rich h4 { font-size:1em; margin:10px 0 4px }
        .chips { display:flex; flex-wrap:wrap; gap:6px } .chip { display:inline-block; padding:2px 10px; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:13px }
        .pill { display:inline-block; padding:1px 10px; border-radius:999px; font-size:13px; font-weight:600 } .yes { background:#dcfce7; color:#166534 } .no { background:#fee2e2; color:#991b1b } .none { background:#f3f4f6; color:var(--muted); font-weight:400 }
        .badge { display:inline-block; padding:1px 9px; border-radius:999px; font-size:12px; font-weight:600; vertical-align:middle } .badge.ok { background:#dcfce7; color:#166534 } .badge.info { background:#dbeafe; color:#1e40af } .badge.bad { background:#fee2e2; color:#991b1b } .badge.muted { background:#f3f4f6; color:#374151 }
        table { border-collapse:collapse; width:100%; font-size:14px; margin:6px 0 } th, td { text-align:left; vertical-align:top; padding:7px 10px; border-bottom:1px solid var(--line); overflow-wrap:anywhere } th { background:var(--bg); font-weight:600; font-size:13px }
        .phases { display:flex; gap:18px; flex-wrap:wrap } .phase { padding:10px 12px; border:1px solid var(--line); border-radius:8px } .phase-name { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px }
        .step { display:inline-block; padding:2px 10px; margin:2px 4px 2px 0; border-radius:999px; background:#f3f4f6; font-size:13px } .step.current { background:var(--accent); color:#fff; font-weight:600 }
        details.assessment { border:1px solid var(--line); border-radius:8px; padding:0 16px 8px; margin:12px 0 } details.assessment summary { cursor:pointer; padding:12px 0; font-size:16px; font-weight:600 } .a-title { margin-right:8px }
        .q { padding:10px 0; border-top:1px solid #f3f4f6 } .q-text { font-weight:600 } .q-text p { margin:0 } .q-desc { color:var(--muted); font-size:13px; margin:2px 0 6px } .q-desc p { margin:0 } .q-answer { margin-top:4px } .q.intro { color:#374151; font-size:14px; background:var(--bg); padding:10px 12px; border-radius:6px; border-top:0 }
        .diagram svg { max-width:100%; height:auto; border:1px solid var(--line); border-radius:8px; background:#fff } pre { background:var(--bg); padding:12px; border-radius:6px; overflow:auto; font-size:13px }
        .comment { padding:10px 0; border-top:1px solid #f3f4f6 } .muted { color:var(--muted) } .small { font-size:13px }
        @media (max-width: 900px) { .layout { grid-template-columns:1fr } nav { position:static; border-right:0; border-bottom:1px solid var(--line) } .row { grid-template-columns:1fr } }
        @media print { nav, .tools, .noprint { display:none } .layout { display:block } header { background:none; padding:0 0 12px } main { padding:0 } body { font-size:12px }
          .row { grid-template-columns:180px 1fr } .row, tr, .phase, .comment { break-inside:avoid } h2, h3, summary, .q-text, .q-desc { break-after:avoid }
          details.assessment summary { list-style:none } a { color:inherit } .diagram svg { border:0 } @page { margin:18mm 15mm } }`;
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${esc(d.title)} · ${esc(d.type)}</title><style>${css}</style></head><body>
<header><div class="crumbs">${d.breadcrumb.map(esc).join(' › ')}</div><h1>${esc(d.title)}</h1>
<div class="meta">${badge(d.type)} ${d.status ? badge(d.status) : ''} · <a href="${esc(d.url)}">Open in Collibra</a></div>
<div class="meta">Created ${esc(d.created)} · Last modified ${esc(d.modified)} · Exported ${esc(d.exported)}${d.generic ? ' · <em>Generic export: this asset is not an AI Use Case</em>' : ''}</div>
${d.responsibilities.length ? `<div class="meta">${d.responsibilities.map(r => `<b>${esc(r.role)}:</b> ${esc(r.owner)}${r.inheritedFrom ? ` <span class="muted">(inherited from ${esc(r.inheritedFrom)})</span>` : ''}`).join(' · ')}</div>` : ''}
<div class="tools"><button onclick="window.print()">Print / Save as PDF</button></div></header>
<div class="layout"><nav>${navItems.map(([id, name]) => `<a href="#${id}">${esc(name)}</a>`).join('')}</nav><main>
${d.sections.map(sectionHtml).join('')}
<section id="assessments"><h2>Assessments</h2>${d.assessments.length ? d.assessments.map(assessment).join('') : '<p class="muted">No assessments.</p>'}</section>
<section id="diagram"><h2>Diagram${d.diagram ? `: ${esc(d.diagram.viewName)}` : ''}</h2>${diagramHtml()}</section>
<section id="comments"><h2>Comments</h2>${d.comments.length ? d.comments.map(c => `<div class="comment"><div class="meta"><b>${esc(c.author)}</b> · ${esc(c.createdOn)}</div><div class="rich">${c.html}</div></div>`).join('') : '<p class="muted">No comments.</p>'}</section>
<section id="attachments"><h2>Attachments</h2>${d.attachments.length ? table(['File', 'Type', 'Size', 'Added'], d.attachments.map(a => [`<a href="${esc(attachmentHref(a))}">${esc(a.name)}</a>`, esc(a.mime), a.size ? esc(Math.round(a.size / 1024) + ' KB') : '', esc(dt(a.createdOn))])) : '<p class="muted">No attachments.</p>'}</section>
<section id="history"><h2>History <span class="muted small">(latest ${d.history.length})</span></h2>${d.history.length ? table(['When', 'Who', 'Action', 'Field', 'From', 'To'], d.history.map(h => [esc(h.when), esc(h.who), esc(h.action), esc(h.field), esc(h.from), esc(h.to)])) : '<p class="muted">No history available.</p>'}</section>
</main></div>
<script>addEventListener('beforeprint',()=>document.querySelectorAll('details').forEach(x=>{x.dataset.o=x.open?'1':'';x.open=true}));addEventListener('afterprint',()=>document.querySelectorAll('details').forEach(x=>{x.open=!!x.dataset.o}))</script>
</body></html>`;
    };

    // 10. Markdown renderer. Rich text is embedded as a fragment, so headings
    //     inside it become bold lines instead of competing with the document outline.
    const wrap = (mark, s) => {
      const mm = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!mm[2] || (mm[2].startsWith(mark) && mm[2].endsWith(mark))) return s; // empty or already marked (<b><strong>…)
      return mm[1] + mark + mm[2] + mark + mm[3];
    };
    const toMd = (node, pre) => {
      if (node.nodeType === 3) return pre ? node.data : (/^\s*\n\s*$/.test(node.data) ? '' : node.data.replace(/\s+/g, ' '));
      if (node.nodeType !== 1) return '';
      const kids = () => [...node.childNodes].map(n => toMd(n, pre)).join('');
      const tag = node.tagName.toLowerCase();
      switch (tag) {
        case 'br': return '  \n';
        case 'p': case 'div': case 'section': return '\n\n' + kids().trim() + '\n\n';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return '\n\n' + wrap('**', kids().trim()) + '\n\n';
        case 'strong': case 'b': return wrap('**', kids());
        case 'em': case 'i': return wrap('*', kids());
        case 's': case 'strike': case 'del': return wrap('~~', kids());
        case 'code': return pre ? kids() : wrap('`', kids());
        case 'pre': return '\n\n```\n' + toMd(node, true).replace(/\n$/, '') + '\n```\n\n';
        case 'hr': return '\n\n---\n\n';
        case 'a': { const href = node.getAttribute('href'); const text = kids().trim(); return !href ? text : !text || href === text ? `<${href}>` : `[${text}](${href})`; }
        case 'img': { const src = node.getAttribute('src') || ''; return /^https?:/.test(src) ? `![${node.getAttribute('alt') || ''}](${src})` : (node.getAttribute('alt') || ''); }
        case 'blockquote': return '\n\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        case 'ul': case 'ol': return '\n\n' + [...node.children].filter(li => li.tagName === 'LI').map((li, i) => (tag === 'ol' ? `${i + 1}. ` : '- ') + toMd(li, pre).trim().replace(/\n/g, '\n   ')).join('\n') + '\n\n';
        case 'table': {
          const rows = [...node.querySelectorAll('tr')].map(tr => '| ' + [...tr.children].map(c => toMd(c, pre).trim().replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|')).join(' | ') + ' |');
          if (rows.length) rows.splice(1, 0, rows[0].replace(/[^|]+/g, ' --- '));
          return '\n\n' + rows.join('\n') + '\n\n';
        }
        default: return kids();
      }
    };
    const htmlToMd = (html) => html ? toMd(new DOMParser().parseFromString(html, 'text/html').body).replace(/\n{3,}/g, '\n\n').replace(/(\n\n|  \n) +/g, '$1').trim() : '';
    const cell = (s) => String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
    const mdTable = (head, rows) => rows.length ? [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '';

    const toMarkdown = (d) => {
      const out = [`# ${d.title}`, '',
        `- **Type:** ${d.type}${d.status ? ` · **Status:** ${d.status}` : ''}`,
        `- **Location:** ${d.breadcrumb.join(' › ')}`,
        `- **Collibra:** <${d.url}>`,
        `- **Created:** ${d.created} · **Modified:** ${d.modified} · **Exported:** ${d.exported}`];
      if (d.generic) out.push('- *Generic export: this asset is not an AI Use Case*');
      if (d.responsibilities.length) out.push(`- **Responsibilities:** ${d.responsibilities.map(r => `${r.role}: ${r.owner}${r.inheritedFrom ? ` (inherited from ${r.inheritedFrom})` : ''}`).join('; ')}`);
      out.push('', '---');
      const value = (b) => b.valueType === 'rich' ? `\n\n${htmlToMd(b.value)}` : b.valueType === 'list' ? b.value.join(', ') : b.valueType === 'bool' ? (b.value ? 'Yes' : 'No') : b.valueType === 'text' && b.value.includes('\n') ? `\n\n${b.value.replace(/\n/g, '  \n')}` : b.value;
      d.sections.forEach(s => {
        out.push('', `## ${s.name}`, '');
        s.blocks.forEach(b => {
          if (b.kind === 'attr') out.push(`**${b.label}:** ${value(b)}`, '');
          else if (b.kind === 'relation') {
            const extras = [...new Set(b.assets.flatMap(a => Object.keys(a.extra)))].slice(0, 6);
            out.push(`**${b.label}:**`, '', mdTable(['Name', 'Type', 'Status', ...extras], b.assets.map(a => [`[${a.name}](${origin}/asset/${a.id})`, a.type, a.status, ...extras.map(k => a.extra[k] || '')])), '');
          } else if (b.kind === 'lifecycle') {
            const l = d.lifecycle;
            out.push(...l.phases.map(p => `- **${p.name}:** ${p.statuses.map(st => st === l.current ? `**${st}** (current)` : st).join(' → ') || '—'}`), '');
            if (l.activities.length) out.push(mdTable(['Status', 'Activity', 'Owner', 'Assignees', 'Last update'], l.activities.map(a => [a.status, a.href ? `[${a.name}](${a.href})` : a.name, a.owner, a.assignees, a.updated])), '');
          } else if (b.kind === 'diagram') out.push('*See the Diagram section below.*', '');
        });
        if (s.empty) out.push(`*${s.empty} empty field${s.empty > 1 ? 's' : ''} omitted.*`, '');
      });
      out.push('', '## Assessments', '');
      if (!d.assessments.length) out.push('*No assessments.*', '');
      const answer = (a) => !a ? '*unanswered*' : a.type === 'rich' ? htmlToMd(a.value) : a.type === 'bool' ? (a.value ? 'Yes' : 'No') : a.type === 'list' ? a.value.map(v => `- ${v}`).join('\n') : a.type === 'assets' ? a.value.map(v => `- [${v.name}](${origin}/asset/${v.id})`).join('\n') : a.value;
      d.assessments.forEach(a => {
        out.push(`### ${a.template}${a.version ? ` (v${a.version})` : ''} — ${a.status}`, '',
          `- **Owner:** ${a.owner || '—'}${a.submittedBy ? ` · **Submitted by:** ${a.submittedBy} on ${a.submittedOn}` : ''} · **Last change:** ${a.modified}`,
          `- [Open in Collibra](${a.href})${a.reviewId ? ` · [Assessment review](${origin}/asset/${a.reviewId})` : ''}`, '');
        a.questions.forEach(q => {
          if (!q.text) { const v = q.answer ? (q.answer.type === 'rich' ? htmlToMd(q.answer.value) : String(q.answer.value)) : ''; if (v) out.push(v.split('\n').map(l => '> ' + l).join('\n'), ''); return; }
          out.push(`#### ${htmlToMd(q.text).replace(/\n+/g, ' ')}`, '');
          if (q.description) out.push(htmlToMd(q.description).split('\n').map(l => '> ' + l).join('\n'), '');
          out.push(answer(q.answer), '');
        });
      });
      out.push('', `## Diagram${d.diagram ? `: ${d.diagram.viewName}` : ''}`, '');
      if (d.diagram) out.push('```mermaid', mermaidOf(d.diagram), '```', '');
      else out.push('*No diagram available.*', '');
      if (d.capturedSvg || drawnSvg) out.push(`![Diagram](${svgName})`, '');
      out.push('', '## Comments', '');
      out.push(...(d.comments.length ? d.comments.flatMap(c => [`**${c.author}** · ${c.createdOn}`, '', htmlToMd(c.html), '']) : ['*No comments.*', '']));
      out.push('', '## Attachments', '');
      out.push(d.attachments.length ? mdTable(['File', 'Type', 'Size', 'Added'], d.attachments.map(a => [`[${a.name}](${a.path || `${origin}/rest/2.0/attachments/${a.id}/file`})`, a.mime, a.size ? Math.round(a.size / 1024) + ' KB' : '', dt(a.createdOn)])) : '*No attachments.*', '');
      out.push('', `## History (latest ${d.history.length})`, '');
      out.push(d.history.length ? mdTable(['When', 'Who', 'Action', 'Field', 'From', 'To'], d.history.map(h => [h.when, h.who, h.action, h.field, h.from, h.to])) : '*No history available.*', '');
      return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
    };

    // 11. Filename prompt decides the format: .zip (everything), .html or .md
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const filename = prompt('Save as (.zip = HTML + Markdown + files, .html or .md = single file):', `collibra_${slug || 'asset'}_${assetId.slice(0, 8)}.zip`);
    if (!filename) return; // user cancelled
    const ext = (filename.match(/\.(zip|html?|md)$/i) || ['.zip'])[0].toLowerCase();
    const base = filename.replace(/\.(zip|html?|md)$/i, '');
    const enc = new TextEncoder();
    let blob;
    if (ext === '.md') {
      doc.attachments.forEach(a => { a.path = ''; }); // single file: link attachments to Collibra
      blob = new Blob([toMarkdown(doc)], { type: 'text/markdown;charset=utf-8' });
    } else if (ext === '.html' || ext === '.htm') {
      blob = new Blob([toHtml(doc, a => `${origin}/rest/2.0/attachments/${a.id}/file`)], { type: 'text/html;charset=utf-8' });
    } else {
      const zipFiles = [
        { name: base + '.html', data: enc.encode(toHtml(doc, a => a.path || `${origin}/rest/2.0/attachments/${a.id}/file`)) },
        { name: base + '.md', data: enc.encode(toMarkdown(doc)) },
        ...files,
        { name: 'raw.json', data: enc.encode(JSON.stringify(raw, null, 1)) }
      ];
      if (doc.capturedSvg || drawnSvg) zipFiles.push({ name: svgName, data: enc.encode(doc.capturedSvg || drawnSvg) });
      // Stored (uncompressed) zip, written by hand so no library is needed
      const CRC = Array.from({ length: 256 }, (_, n) => {
        for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
        return n >>> 0;
      });
      const crc32 = (u8) => { let c = ~0; for (const b of u8) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
      const now = new Date();
      const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
      const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      const record = (fields) => {
        const v = new DataView(new ArrayBuffer(fields.reduce((s, [n]) => s + n, 0)));
        let o = 0;
        fields.forEach(([n, x]) => { n === 4 ? v.setUint32(o, x, true) : v.setUint16(o, x, true); o += n; });
        return new Uint8Array(v.buffer);
      };
      const out = [], central = [];
      let offset = 0;
      for (const f of zipFiles) {
        const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
        // Shared header fields; flag 0x0800 marks UTF-8 filenames, method 0 = stored
        const common = [[2, 20], [2, 0x0800], [2, 0], [2, dosTime], [2, dosDate], [4, crc], [4, size], [4, size], [2, name.length], [2, 0]];
        const local = record([[4, 0x04034b50], ...common]);
        out.push(local, name, f.data);
        central.push(record([[4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), name);
        offset += local.length + name.length + size;
      }
      const cdSize = central.reduce((s, p) => s + p.length, 0);
      const end = record([[4, 0x06054b50], [2, 0], [2, 0], [2, zipFiles.length], [2, zipFiles.length], [4, cdSize], [4, offset], [2, 0]]);
      blob = new Blob([...out, ...central, end], { type: 'application/zip' });
    }

    // 12. Download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = base + (ext === '.htm' ? '.html' : ext);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {
    alert('Export failed: ' + e.message);
    console.error(e);
  }
})();
