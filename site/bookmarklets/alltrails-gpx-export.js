/**
 * AllTrails GPX export bookmarklet
 *
 * Run it on a trail's map page on alltrails.com, after the map has finished
 * loading. To draw the route, the page already asks its own API for the
 * line and elevation data and loads it into your browser — this just reads
 * that same data (via the browser's standard Performance/Resource Timing
 * API, which lists requests the page itself already made, and a client
 * header read back out of the page's own public JavaScript) and saves it
 * as a plain .gpx track file you can use in any map or GPS app.
 *
 * @title Export AllTrails GPX
 * @description Saves the trail map you're viewing on alltrails.com as a .gpx file,
 *              from the route data your browser already loaded to draw the map.
 * @order 30
 */
(async () => {
  try {
    if (!location.hostname.endsWith('alltrails.com')) {
      alert('Open a trail map page on alltrails.com first.');
      return;
    }

    // The map page fetches its own route/elevation data to draw the map;
    // find that request among the ones the browser already made.
    const mapUrls = [...new Set(
      performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => /\/api\/alltrails\/maps\/\d+/.test(u))
    )];
    if (!mapUrls.length) {
      alert('Could not find the map data yet — make sure the map has finished loading, then try again.');
      return;
    }
    const mapUrl = mapUrls[mapUrls.length - 1];

    // That request carries a client header alongside the session cookie.
    // It's a fixed string shipped in the page's own public JS (the same one
    // the site also hands to third-party map-tile providers as a "key="
    // query parameter), so it's read back out of that JS rather than
    // copied here, in case the site ever changes it.
    const findClientKey = async () => {
      const scriptUrls = [...new Set(
        performance.getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.endsWith('.js') && u.includes('cloudfront.net'))
      )];
      for (const url of scriptUrls) {
        try {
          const text = await (await fetch(url)).text();
          const headerIdx = text.search(/"X-AT-KEY"\s*:/i);
          if (headerIdx === -1) continue;
          const before = text.slice(Math.max(0, headerIdx - 500), headerIdx);
          const tokens = [...before.matchAll(/=\s*"([a-z0-9]{24,40})"/gi)];
          if (tokens.length) return tokens[tokens.length - 1][1];
        } catch (e) { /* try the next chunk */ }
      }
      return null;
    };
    const clientKey = await findClientKey();
    if (!clientKey) {
      alert('Could not find the site\'s client key in its scripts — AllTrails may have changed its code.');
      return;
    }

    const res = await fetch(mapUrl, { credentials: 'include', headers: { 'X-AT-KEY': clientKey } });
    if (!res.ok) { alert(`Could not load the map data (HTTP ${res.status}).`); return; }
    const data = await res.json();
    const map = (data.maps || [])[0];
    if (!map) { alert('No route data in the response — AllTrails may have changed its API.'); return; }

    // Both the route line and its elevation profile are delta-encoded the
    // same way a Google-style polyline is: a run of base-64-ish characters
    // decoding to a stream of zigzag-varint signed integers.
    const decodeDeltas = (str) => {
      const out = [];
      let index = 0;
      while (index < str.length) {
        let shift = 0, result = 0, byte;
        do {
          byte = str.charCodeAt(index++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        out.push(result & 1 ? ~(result >> 1) : (result >> 1));
      }
      return out;
    };

    const decodePoints = (pointsData) => {
      const deltas = decodeDeltas(pointsData);
      const coords = [];
      let lat = 0, lng = 0;
      for (let i = 0; i < deltas.length; i += 2) {
        lat += deltas[i];
        lng += deltas[i + 1];
        coords.push([lat / 1e5, lng / 1e5]);
      }
      return coords;
    };

    // Pairs of (point-index step, elevation delta); only the elevation
    // stream is needed, the index just confirms it lines up with the points.
    const decodeElevations = (indexedElevationData) => {
      if (!indexedElevationData) return null;
      const deltas = decodeDeltas(indexedElevationData);
      const elevations = [];
      let ele = 0;
      for (let i = 0; i < deltas.length; i += 2) {
        ele += deltas[i + 1];
        elevations.push(ele / 1e5);
      }
      return elevations;
    };

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const segments = [];
    (map.routes || []).forEach((route) => {
      (route.lineSegments || [])
        .slice()
        .sort((a, b) => a.sequenceNum - b.sequenceNum)
        .forEach((seg) => {
          const poly = seg.polyline || {};
          if (!poly.pointsData) return;
          const coords = decodePoints(poly.pointsData);
          const elevations = decodeElevations(poly.indexedElevationData);
          const points = coords.map(([lat, lng], i) => {
            const ele = elevations && elevations[i] != null ? `<ele>${elevations[i].toFixed(1)}</ele>` : '';
            return `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele}</trkpt>`;
          }).join('\n');
          segments.push(`    <trkseg>\n${points}\n    </trkseg>`);
        });
    });
    if (!segments.length) { alert('No route line found for this trail.'); return; }

    const trailName = map.name || 'AllTrails trail';
    const gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="AllTrails GPX export bookmarklet" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      `  <metadata><name>${esc(trailName)}</name><link href="${esc(location.href)}"></link></metadata>\n` +
      `  <trk><name>${esc(trailName)}</name>\n${segments.join('\n')}\n  </trk>\n` +
      '</gpx>\n';

    const slug = trailName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const suggested = `${slug || 'trail'}.gpx`;
    const filename = prompt('Save trail as:', suggested);
    if (!filename) return; // user cancelled

    const blob = new Blob([gpx], { type: 'application/gpx+xml;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith('.gpx') ? filename : filename + '.gpx';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {
    alert('Export failed: ' + e.message);
    console.error(e);
  }
})();
