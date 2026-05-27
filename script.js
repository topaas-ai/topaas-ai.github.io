/* =====================================================================
   Topaas — Topology-as-a-Service
   Interactions · v0.2
   ===================================================================== */

(() => {
  'use strict';

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ===================================================================
     CONFIG
     =================================================================== */

  // Set this to your Formspree endpoint to enable real form submissions.
  // e.g. "https://formspree.io/f/abcdwxyz"
  // If left empty, the form falls back to a mailto: link.
  const FORMSPREE_ENDPOINT = '';
  const CONTACT_EMAIL = 'hello@topaas.ai';

  /* ===================================================================
     1. BACKGROUND GRAPH NETWORK
     A force-directed graph that drifts slowly. Nodes are coloured by
     a binary "super-partner" label (cyan / magenta). Edges glow.
     Mouse acts as a soft repulsive source.
     =================================================================== */

  const canvas = document.getElementById('field');
  const ctx = canvas.getContext('2d', { alpha: true });

  let W = 0, H = 0, DPR = 1;
  let nodes = [];
  let edges = [];
  let fiedler = null;        // v₂ — second-smallest eigenvector of L
  let fiedlerLambda = 0;     // λ₂ — algebraic connectivity
  let cutCount = 0;          // # edges across the Fiedler cut
  let adj = null;            // per-node neighbour lists for fast L·x

  // Mouse in screen space
  const mouse = { x: -9999, y: -9999, alive: false };

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildGraph();
  }

  function buildGraph() {
    const targetN = Math.max(48, Math.round(74 * (W / 1440)));
    nodes = [];
    edges = [];

    for (let i = 0; i < targetN; i++) {
      nodes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: 0, vy: 0,
        r: 0.8 + Math.random() * 1.2,
        // Two super-partner classes: 0=cyan, 1=magenta. Some neutral.
        c: Math.random() < 0.55 ? 0 : (Math.random() < 0.7 ? 1 : 2),
        phase: Math.random() * Math.PI * 2,
        deg: 0
      });
    }

    // Build a small-world-ish topology: connect to a few nearest neighbours
    // plus some long-range "shortcut" edges.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      // Sort by distance, take k closest
      const dists = [];
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const dx = nodes[j].x - a.x;
        const dy = nodes[j].y - a.y;
        dists.push({ j, d: dx * dx + dy * dy });
      }
      dists.sort((p, q) => p.d - q.d);
      const k = 2 + (Math.random() < 0.35 ? 1 : 0);
      for (let m = 0; m < k; m++) {
        const j = dists[m].j;
        if (j > i) edges.push({ a: i, b: j, w: 0.4 + Math.random() * 0.6 });
      }
      // Long-range shortcut
      if (Math.random() < 0.15) {
        const j = Math.floor(Math.random() * nodes.length);
        if (j !== i && j > i) edges.push({ a: i, b: j, w: 0.2 + Math.random() * 0.3 });
      }
    }

    // Compute node degrees + adjacency lists
    adj = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) adj[i] = [];
    for (const e of edges) {
      nodes[e.a].deg++;
      nodes[e.b].deg++;
      adj[e.a].push(e.b);
      adj[e.b].push(e.a);
    }

    // Compute the Fiedler vector v₂ — eigenvector of the graph
    // Laplacian L = D − A corresponding to the second-smallest
    // eigenvalue λ₂. Drives the spectral clustering of the background.
    computeFiedler();

    // Recolor nodes by their sign on the Fiedler vector. This makes the
    // cyan / magenta separation an actual spectral partition, not random.
    // Small |v[i]| → "on the cut" → violet.
    if (fiedler) {
      // Find a robust scale (median of |v|) so the violet band is meaningful
      const absSorted = [...fiedler].map(Math.abs).sort((a, b) => a - b);
      const median = absSorted[Math.floor(absSorted.length / 2)] || 1;
      const cutBand = median * 0.35;
      for (let i = 0; i < nodes.length; i++) {
        const x = fiedler[i];
        if (Math.abs(x) < cutBand)    nodes[i].c = 2; // boundary
        else if (x > 0)                nodes[i].c = 0; // partition A — cyan
        else                           nodes[i].c = 1; // partition B — magenta
      }
      // Count cut edges (sign(v[a]) ≠ sign(v[b]))
      cutCount = 0;
      for (const e of edges) {
        if (fiedler[e.a] * fiedler[e.b] < 0) {
          cutCount++;
          e.cut = true;
        } else {
          e.cut = false;
        }
      }
    }

    // Update the live HUD with the new values
    updateLaplacianHUD();
  }

  /* — Live HUD that surfaces the live graph-Laplacian metrics —
     λ₂(G) is the algebraic connectivity; cut is the # of edges
     whose endpoints fall on opposite sides of the Fiedler cut. */
  let hudEl = null;
  function ensureLaplacianHUD() {
    if (hudEl) return;
    hudEl = document.createElement('div');
    hudEl.className = 'lap-hud';
    hudEl.setAttribute('aria-hidden', 'true');
    hudEl.innerHTML =
      '<span class="lap-hud-title">background.L</span>' +
      '<span class="lap-hud-sep">·</span>' +
      '<span class="lap-hud-pair"><span class="lap-hud-label">λ₂</span><span class="lap-hud-val" data-k="lambda">—</span></span>' +
      '<span class="lap-hud-sep">·</span>' +
      '<span class="lap-hud-pair"><span class="lap-hud-label">|V|</span><span class="lap-hud-val" data-k="V">—</span></span>' +
      '<span class="lap-hud-sep">·</span>' +
      '<span class="lap-hud-pair"><span class="lap-hud-label">|E|</span><span class="lap-hud-val" data-k="E">—</span></span>' +
      '<span class="lap-hud-sep">·</span>' +
      '<span class="lap-hud-pair"><span class="lap-hud-label">cut</span><span class="lap-hud-val" data-k="cut">—</span></span>';
    document.body.appendChild(hudEl);
  }

  function updateLaplacianHUD() {
    ensureLaplacianHUD();
    const set = (k, v) => {
      const el = hudEl.querySelector('[data-k="' + k + '"]');
      if (el) el.textContent = v;
    };
    set('lambda', fiedlerLambda.toFixed(4));
    set('V', nodes.length);
    set('E', edges.length);
    set('cut', cutCount);
    hudEl.classList.remove('flash');
    void hudEl.offsetWidth;     // force reflow to restart the animation
    hudEl.classList.add('flash');
  }

  /* — Fiedler vector via shifted power iteration with deflation —
     We want the eigenvector of L for the smallest non-zero eigenvalue
     (λ₂ — the algebraic connectivity). Trick: iterate (M·I − L) which
     has the SAME eigenvectors but the eigenvalues are reflected, so
     the small λ of L become the large of (M·I − L), and ordinary power
     iteration converges. Deflate the constant vector (v₁) by removing
     the mean each step. */
  function computeFiedler() {
    const N = nodes.length;
    if (!N) { fiedler = null; return; }

    // Diagonal of L is the degree vector
    const D = new Float32Array(N);
    for (let i = 0; i < N; i++) D[i] = adj[i].length;
    let dmax = 0;
    for (let i = 0; i < N; i++) if (D[i] > dmax) dmax = D[i];
    const M = (dmax + 1) * 2;   // shift so (M·I − L) is PSD-ish

    // (M·I − L) · x  =  M·x − L·x  =  M·x − (D·x − A·x)  =  (M − D)·x + A·x
    function shifted(x, out) {
      for (let i = 0; i < N; i++) {
        let s = (M - D[i]) * x[i];
        const ni = adj[i];
        for (let k = 0; k < ni.length; k++) s += x[ni[k]];
        out[i] = s;
      }
    }

    let v = new Float32Array(N);
    let w = new Float32Array(N);
    // Random init with mean 0
    let sum = 0;
    for (let i = 0; i < N; i++) { v[i] = Math.random() - 0.5; sum += v[i]; }
    const meanInit = sum / N;
    for (let i = 0; i < N; i++) v[i] -= meanInit;

    const ITERS = 90;
    for (let it = 0; it < ITERS; it++) {
      // Deflate: project out the constant vector (v₁ = (1,…,1)/√N)
      let m = 0;
      for (let i = 0; i < N; i++) m += v[i];
      m /= N;
      let norm = 0;
      for (let i = 0; i < N; i++) {
        v[i] -= m;
        norm += v[i] * v[i];
      }
      norm = Math.sqrt(norm);
      if (norm < 1e-9) {
        for (let i = 0; i < N; i++) v[i] = Math.random() - 0.5;
        continue;
      }
      for (let i = 0; i < N; i++) v[i] /= norm;
      // Apply shifted operator
      shifted(v, w);
      const t = v; v = w; w = t;
    }

    // Final clean-up: deflate + normalize
    let m = 0;
    for (let i = 0; i < N; i++) m += v[i];
    m /= N;
    let n2 = 0;
    for (let i = 0; i < N; i++) { v[i] -= m; n2 += v[i] * v[i]; }
    const nn = Math.sqrt(n2) || 1;
    for (let i = 0; i < N; i++) v[i] /= nn;

    // Rayleigh quotient for λ₂ = vᵀ L v
    // L·v = D·v − A·v
    let lambda = 0;
    for (let i = 0; i < N; i++) {
      let lv = D[i] * v[i];
      const ni = adj[i];
      for (let k = 0; k < ni.length; k++) lv -= v[ni[k]];
      lambda += v[i] * lv;
    }
    fiedler = v;
    fiedlerLambda = lambda;
  }

  function step(dt) {
    // Fade previous frame for trails
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0, 2, 8, 0.18)';
    ctx.fillRect(0, 0, W, H);

    // Force simulation
    const k_repel = 1400;       // node-node repulsion
    const k_spring = 0.0012;    // edge spring
    const k_drift = 0.000005;   // global drift toward centre
    const k_mouse = 24000;      // mouse repulsion
    const damp = 0.84;
    const targetEdgeLen = 110;

    const N = nodes.length;
    // Spatial neighbours: O(n^2) but n is small (<= ~90)
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        const inv = k_repel / (d2 * Math.sqrt(d2));
        a.vx -= dx * inv;
        a.vy -= dy * inv;
        b.vx += dx * inv;
        b.vy += dy * inv;
      }
    }

    // Spring forces along edges
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const stretch = (d - targetEdgeLen) * k_spring * e.w;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * stretch;
      a.vy += uy * stretch;
      b.vx -= ux * stretch;
      b.vy -= uy * stretch;
    }

    // Mouse repulsion
    if (mouse.alive) {
      for (const a of nodes) {
        const dx = a.x - mouse.x;
        const dy = a.y - mouse.y;
        const d2 = dx * dx + dy * dy + 1;
        if (d2 < 60000) {
          const inv = k_mouse / (d2 * Math.sqrt(d2));
          a.vx += dx * inv;
          a.vy += dy * inv;
        }
      }
    }

    // Integrate + soft pull toward centre + boundary
    const cx = W * 0.5, cy = H * 0.5;
    for (const a of nodes) {
      a.vx += (cx - a.x) * k_drift;
      a.vy += (cy - a.y) * k_drift;
      a.vx *= damp;
      a.vy *= damp;
      a.x += a.vx;
      a.y += a.vy;

      // Soft wrap if escapes
      if (a.x < -20) a.x = W + 20;
      else if (a.x > W + 20) a.x = -20;
      if (a.y < -20) a.y = H + 20;
      else if (a.y > H + 20) a.y = -20;

      a.phase += 0.012;
    }

    // ---- Draw edges ----
    ctx.globalCompositeOperation = 'lighter';
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 260) continue;
      const t = 1 - d / 260;
      // Cut-edges (across the Fiedler partition) carry the Laplacian
      // signal and get a slightly stronger violet draw.
      const isCut = e.cut === true;
      const alpha = isCut
        ? 0.075 + 0.18 * t * e.w
        : 0.05  + 0.12 * t * e.w;
      let col;
      if (isCut)                        col = `rgba(159,123,255,${alpha})`;
      else if (a.c === 0 && b.c === 0)  col = `rgba(107,242,255,${alpha})`;
      else if (a.c === 1 && b.c === 1)  col = `rgba(255,91,216,${alpha})`;
      else                               col = `rgba(159,123,255,${alpha * 0.85})`;
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.5 + e.w * 0.55 + (isCut ? 0.25 : 0);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // ---- Draw nodes ----
    for (const a of nodes) {
      const pulse = 0.85 + Math.sin(a.phase) * 0.15;
      const r = a.r * pulse;
      let fill, glow;
      if (a.c === 0) {
        fill = 'rgba(107, 242, 255, 0.55)';
        glow = 'rgba(107, 242, 255, 0.16)';
      } else if (a.c === 1) {
        fill = 'rgba(255, 91, 216, 0.55)';
        glow = 'rgba(255, 91, 216, 0.16)';
      } else {
        fill = 'rgba(236, 237, 242, 0.45)';
        glow = 'rgba(236, 237, 242, 0.10)';
      }

      // Glow halo (much smaller, much dimmer than before)
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();

      // Core
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let rafId = 0;
  let lastFrameT = performance.now();
  function loop(now) {
    const dt = now - lastFrameT;
    lastFrameT = now;
    step(dt);
    rafId = requestAnimationFrame(loop);
  }

  if (!prefersReduced) {
    resize();
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('pointermove', (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.alive = true;
    }, { passive: true });
    window.addEventListener('pointerleave', () => { mouse.alive = false; });
    loop(lastFrameT);
  } else {
    // Reduced motion: draw a static snapshot
    resize();
    // Run a few iterations to settle
    for (let s = 0; s < 60; s++) step(16);
    cancelAnimationFrame(rafId);
  }

  /* ===================================================================
     2. HERO INSTRUMENT — Live graph + Laplacian spectrum
     A small force-directed graph showing 3 spectral clusters. Periodically
     re-randomises to suggest "components being discovered".
     =================================================================== */

  const graphEdges = document.getElementById('graph-edges');
  const graphNodes = document.getElementById('graph-nodes');
  const spectrumBars = document.getElementById('spectrum-bars');
  const roV    = document.getElementById('ro-V');
  const roE    = document.getElementById('ro-E');
  const roChi  = document.getElementById('ro-chi');
  const roK    = document.getElementById('ro-k');
  const roL2   = document.getElementById('ro-l2');
  const roLmax = document.getElementById('ro-lmax');
  const roGap  = document.getElementById('ro-gap');

  const svgns = 'http://www.w3.org/2000/svg';

  const SVG_GW = 380, SVG_GH = 175;
  const SVG_SW = 380, SVG_SH = 65;

  let G = { nodes: [], edges: [] };
  let nodeEls = [];
  let edgeEls = [];

  function makeGraph() {
    // 3 clusters of ~4 nodes each, sparsely connected to each other
    const clusterCount = 3;
    const perCluster = [4, 5, 4];
    const colors = ['cyan', 'magenta', 'violet'];
    const centres = [
      { x: SVG_GW * 0.22, y: SVG_GH * 0.32 },
      { x: SVG_GW * 0.50, y: SVG_GH * 0.72 },
      { x: SVG_GW * 0.78, y: SVG_GH * 0.30 }
    ];

    const Ns = [];
    const Es = [];
    let idx = 0;

    for (let c = 0; c < clusterCount; c++) {
      const cluster = [];
      for (let i = 0; i < perCluster[c]; i++) {
        const angle = (i / perCluster[c]) * Math.PI * 2 + Math.random();
        const radius = 14 + Math.random() * 18;
        Ns.push({
          x: centres[c].x + Math.cos(angle) * radius + (Math.random() - 0.5) * 6,
          y: centres[c].y + Math.sin(angle) * radius + (Math.random() - 0.5) * 6,
          vx: 0, vy: 0,
          c: c,
          color: colors[c],
          id: idx
        });
        cluster.push(idx);
        idx++;
      }
      // Densely connect within cluster
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          if (Math.random() < 0.7) Es.push({ a: cluster[i], b: cluster[j], w: 0.9 });
        }
      }
    }

    // Sparse inter-cluster edges (1-2 between clusters)
    for (let c1 = 0; c1 < clusterCount; c1++) {
      for (let c2 = c1 + 1; c2 < clusterCount; c2++) {
        const linksCount = Math.random() < 0.5 ? 1 : 2;
        for (let l = 0; l < linksCount; l++) {
          const i = Ns.findIndex(n => n.c === c1 && Math.random() < 0.4);
          const j = Ns.findIndex(n => n.c === c2 && Math.random() < 0.4);
          const ii = i === -1 ? Ns.findIndex(n => n.c === c1) : i;
          const jj = j === -1 ? Ns.findIndex(n => n.c === c2) : j;
          if (ii !== -1 && jj !== -1) Es.push({ a: ii, b: jj, w: 0.3 });
        }
      }
    }

    G.nodes = Ns;
    G.edges = Es;
  }

  function colorVar(name) {
    if (name === 'cyan') return 'rgb(107, 242, 255)';
    if (name === 'magenta') return 'rgb(255, 91, 216)';
    if (name === 'violet') return 'rgb(159, 123, 255)';
    return 'rgb(236, 237, 242)';
  }

  function renderGraph() {
    if (!graphNodes || !graphEdges) return;
    graphNodes.innerHTML = '';
    graphEdges.innerHTML = '';
    nodeEls = [];
    edgeEls = [];

    for (const e of G.edges) {
      const ln = document.createElementNS(svgns, 'line');
      const a = G.nodes[e.a], b = G.nodes[e.b];
      ln.setAttribute('x1', a.x.toFixed(2));
      ln.setAttribute('y1', a.y.toFixed(2));
      ln.setAttribute('x2', b.x.toFixed(2));
      ln.setAttribute('y2', b.y.toFixed(2));
      ln.setAttribute('stroke', e.w > 0.6 ? 'rgba(220,230,255,0.45)' : 'rgba(220,230,255,0.18)');
      ln.setAttribute('stroke-width', e.w > 0.6 ? '1' : '0.6');
      graphEdges.appendChild(ln);
      edgeEls.push({ el: ln, e });
    }
    for (const n of G.nodes) {
      // Halo
      const halo = document.createElementNS(svgns, 'circle');
      halo.setAttribute('cx', n.x.toFixed(2));
      halo.setAttribute('cy', n.y.toFixed(2));
      halo.setAttribute('r', '8');
      halo.setAttribute('fill', colorVar(n.color));
      halo.setAttribute('opacity', '0.18');
      graphNodes.appendChild(halo);

      const c = document.createElementNS(svgns, 'circle');
      c.setAttribute('cx', n.x.toFixed(2));
      c.setAttribute('cy', n.y.toFixed(2));
      c.setAttribute('r', '3.4');
      c.setAttribute('fill', colorVar(n.color));
      c.setAttribute('stroke', 'rgba(0,0,0,0.4)');
      c.setAttribute('stroke-width', '0.6');
      graphNodes.appendChild(c);
      nodeEls.push({ el: c, halo, n });
    }
  }

  function simulateGraph() {
    // Mini force-directed
    const k_repel = 90;
    const k_spring = 0.06;
    const damp = 0.78;
    const target = 28;

    for (let i = 0; i < G.nodes.length; i++) {
      const a = G.nodes[i];
      for (let j = i + 1; j < G.nodes.length; j++) {
        const b = G.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 1;
        const inv = k_repel / d2;
        a.vx -= dx * inv;
        a.vy -= dy * inv;
        b.vx += dx * inv;
        b.vy += dy * inv;
      }
    }
    for (const e of G.edges) {
      const a = G.nodes[e.a], b = G.nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const stretch = (d - target) * k_spring * e.w;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * stretch;
      a.vy += uy * stretch;
      b.vx -= ux * stretch;
      b.vy -= uy * stretch;
    }
    for (const a of G.nodes) {
      // Soft pull toward cluster centre
      const cx = SVG_GW / 2, cy = SVG_GH / 2;
      a.vx += (cx - a.x) * 0.0014;
      a.vy += (cy - a.y) * 0.0014;
      a.vx *= damp;
      a.vy *= damp;
      a.x += a.vx;
      a.y += a.vy;
      // Boundary
      a.x = Math.max(12, Math.min(SVG_GW - 12, a.x));
      a.y = Math.max(12, Math.min(SVG_GH - 12, a.y));
    }
  }

  function updateGraphDOM() {
    for (const ne of nodeEls) {
      ne.el.setAttribute('cx', ne.n.x.toFixed(2));
      ne.el.setAttribute('cy', ne.n.y.toFixed(2));
      ne.halo.setAttribute('cx', ne.n.x.toFixed(2));
      ne.halo.setAttribute('cy', ne.n.y.toFixed(2));
    }
    for (const ee of edgeEls) {
      const a = G.nodes[ee.e.a], b = G.nodes[ee.e.b];
      ee.el.setAttribute('x1', a.x.toFixed(2));
      ee.el.setAttribute('y1', a.y.toFixed(2));
      ee.el.setAttribute('x2', b.x.toFixed(2));
      ee.el.setAttribute('y2', b.y.toFixed(2));
    }
  }

  /* ---- Spectrum bars ---- */
  const BAR_COUNT = 28;
  const barW = SVG_SW / BAR_COUNT;
  const barGap = 2;
  const barEls = [];

  if (spectrumBars) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const rect = document.createElementNS(svgns, 'rect');
      rect.setAttribute('x', (i * barW + barGap / 2).toFixed(2));
      rect.setAttribute('width', (barW - barGap).toFixed(2));
      rect.setAttribute('y', SVG_SH - 4);
      rect.setAttribute('height', 0);
      rect.setAttribute('fill', 'currentColor');
      rect.setAttribute('rx', '0.6');
      spectrumBars.appendChild(rect);
      barEls.push(rect);
    }
  }

  function spectrumValues() {
    // Real graph Laplacians of small connected graphs have:
    // - λ_0 = 0 (always)
    // - small algebraic connectivity λ_1 (Fiedler)
    // - growing eigenvalues with a plateau
    // We synthesize a plausible spectrum.
    const out = new Array(BAR_COUNT);
    out[0] = 0;
    // small jump for first non-zero eigenvalue
    const fiedler = 0.08 + Math.random() * 0.12;
    out[1] = fiedler;
    for (let i = 2; i < BAR_COUNT; i++) {
      // Roughly cosine-shaped ascending pattern with noise
      const t = (i - 1) / (BAR_COUNT - 1);
      out[i] = Math.min(1,
        fiedler + (1 - fiedler) * (1 - Math.cos(t * Math.PI)) * 0.5
        + (Math.random() - 0.5) * 0.08
      );
    }
    return out;
  }

  function applySpectrum(vals) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const h = vals[i] * (SVG_SH - 6);
      const y = SVG_SH - 4 - h;
      barEls[i].setAttribute('y', y.toFixed(2));
      barEls[i].setAttribute('height', h.toFixed(2));
    }
    return vals;
  }

  function updateReadouts(spec) {
    if (!G.nodes) return;
    const V = G.nodes.length;
    const E = G.edges.length;
    // For a planar-ish graph, Euler characteristic χ = V − E + F ≈ 2 - 2g
    // We'll compute a plausible χ based on V and E (V - E + 1 for forest, 2 for connected planar).
    const chi = V - E + Math.max(1, Math.round(Math.abs(V - E) / 8));
    // k = number of clusters (count of distinct cluster ids)
    const ks = new Set(G.nodes.map(n => n.c)).size;

    if (roV)   roV.textContent   = V;
    if (roE)   roE.textContent   = E;
    if (roChi) roChi.textContent = chi >= 0 ? `+${chi}` : String(chi);
    if (roK)   roK.textContent   = ks;

    if (spec) {
      const l2 = spec[1].toFixed(2);
      const lmax = spec[BAR_COUNT - 1].toFixed(2);
      const gap = (parseFloat(l2)).toFixed(2);
      if (roL2)   roL2.textContent   = l2;
      if (roLmax) roLmax.textContent = lmax;
      if (roGap)  roGap.textContent  = gap;
    }
  }

  // Initial render
  if (graphNodes) {
    makeGraph();
    // Settle initial positions
    for (let s = 0; s < 40; s++) simulateGraph();
    renderGraph();
    const sp = applySpectrum(spectrumValues());
    updateReadouts(sp);
  } else {
    updateReadouts(null);
  }

  // Animation loop
  let lastResetT = 0;
  function instrumentLoop(now) {
    if (!prefersReduced) {
      simulateGraph();
      updateGraphDOM();
      // Re-randomise periodically to suggest re-discovery
      if (now - lastResetT > 7500) {
        makeGraph();
        for (let s = 0; s < 40; s++) simulateGraph();
        renderGraph();
        const sp = applySpectrum(spectrumValues());
        updateReadouts(sp);
        lastResetT = now;
      }
    }
    requestAnimationFrame(instrumentLoop);
  }
  if (!prefersReduced) requestAnimationFrame(instrumentLoop);

  /* ===================================================================
     3. SCROLL REVEAL
     =================================================================== */

  const revealTargets = document.querySelectorAll(
    '.section-head, .step, .note, .transmit-form, .ops-caption, .hero-tape'
  );
  revealTargets.forEach(el => el.classList.add('fade-up'));

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
    revealTargets.forEach(el => io.observe(el));

    // Defensive fallback
    setTimeout(() => {
      document.querySelectorAll('.fade-up:not(.is-in)').forEach(el => el.classList.add('is-in'));
    }, 6000);
  } else {
    revealTargets.forEach(el => el.classList.add('is-in'));
  }

  /* ===================================================================
     4. SMOOTH SCROLL
     =================================================================== */

  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#' || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'start' });
    });
  });

  /* ===================================================================
     5. CONTACT FORM
     =================================================================== */

  const form = document.getElementById('contact-form');
  const formStatus = document.getElementById('form-status');

  function setStatus(msg, state) {
    if (!formStatus) return;
    formStatus.textContent = msg;
    if (state) formStatus.setAttribute('data-state', state);
    else formStatus.removeAttribute('data-state');
  }

  function collect() {
    const data = new FormData(form);
    return {
      name:        (data.get('name')        || '').toString().trim(),
      email:       (data.get('email')       || '').toString().trim(),
      affiliation: (data.get('affiliation') || '').toString().trim(),
      role:        (data.get('role')        || '').toString().trim(),
      note:        (data.get('note')        || '').toString().trim(),
    };
  }

  function validate(d) {
    if (!d.name) return 'A name, please.';
    if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'A reachable email, please.';
    return null;
  }

  function buildMailto(d) {
    const subject = encodeURIComponent(`[Topaas] Signal from ${d.name}`);
    const lines = [
      `Name: ${d.name}`,
      `Email: ${d.email}`,
      `Affiliation: ${d.affiliation || '—'}`,
      `Manifold: ${d.role || '—'}`,
      '',
      'Signal:',
      d.note || '—'
    ];
    return `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${encodeURIComponent(lines.join('\n'))}`;
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const d = collect();
      const err = validate(d);
      if (err) {
        setStatus(err, 'error');
        return;
      }
      setStatus('Transmitting…', null);

      if (FORMSPREE_ENDPOINT) {
        try {
          const res = await fetch(FORMSPREE_ENDPOINT, {
            method: 'POST',
            headers: { 'Accept': 'application/json' },
            body: new FormData(form)
          });
          if (res.ok) {
            form.reset();
            setStatus(`Received. We will reply to you at ${d.email}.`, 'success');
          } else {
            throw new Error('Submission failed');
          }
        } catch (_) {
          setStatus('Could not transmit. Opening your mail client instead…', 'error');
          window.location.href = buildMailto(d);
        }
      } else {
        window.location.href = buildMailto(d);
        setStatus(`Opening your mail client. If nothing happens, write to ${CONTACT_EMAIL}.`, 'success');
      }
    });
  }

  /* ===================================================================
     6. PARALLAX — instrument tilt on scroll
     =================================================================== */

  const instrument = document.querySelector('.instrument');
  if (!prefersReduced && instrument) {
    let lastY = 0, ticking = false;
    window.addEventListener('scroll', () => {
      lastY = window.scrollY;
      if (!ticking) {
        requestAnimationFrame(() => {
          if (lastY < 900) {
            instrument.style.transform =
              `perspective(2200px) rotateY(-2.5deg) rotateX(${1 - lastY * 0.005}deg) translateY(${lastY * -0.06}px)`;
          }
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

})();
