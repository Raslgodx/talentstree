const WOWHEAD_ICON_BASE = "https://wow.zamimg.com/images/wow/icons/large/";
const SVG_NS = "http://www.w3.org/2000/svg";

// Talent export alphabet
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function wowheadIconUrl(iconName) {
  if (!iconName) return null;
  return `${WOWHEAD_ICON_BASE}${String(iconName).toLowerCase()}.jpg`;
}

function elSvg(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getQuery() {
  const u = new URL(window.location.href);
  return {
    spec: (u.searchParams.get("spec") || "affliction").toLowerCase(),
    code: (u.searchParams.get("code") || "").trim(),
    hero: (u.searchParams.get("hero") || "").toLowerCase(), // <-- добавили
    debug: u.searchParams.get("debug") === "1"
  };
}


function specKeyToName(key) {
  const k = (key || "").toLowerCase();
  if (k === "affliction") return "Affliction";
  if (k === "demonology") return "Demonology";
  if (k === "destruction") return "Destruction";
  return "Affliction";
}
function heroKeyToSubTreeId(heroKey) {
  // по твоему JSON:
  // 57 = Soul Harvester
  // 58 = Hellcaller
  // 59 = Diabolist
  if (!heroKey) return null;

  const k = heroKey.toLowerCase();
  if (k === "soulharvester") return 57;
  if (k === "hellcaller") return 58;
  if (k === "diabolist") return 59;

  return null;
}

async function loadModels() {
  const res = await fetch("./talents.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load talents.json");
  return res.json();
}

function buildNodeIndex(model) {
  const idx = new Map();
  for (const n of model.classNodes || []) idx.set(n.id, { ...n, _tree: "class" });
  for (const n of model.specNodes || []) idx.set(n.id, { ...n, _tree: "spec" });
  for (const n of model.heroNodes || []) idx.set(n.id, { ...n, _tree: "hero" });
  // subTreeNodes are not rendered as nodes in your dataset; they are like "tabs"
  model._nodeIndex = idx;
  return model;
}

function pickModel(models, specKey) {
  const specName = specKeyToName(specKey);
  const model = models.find((m) => m.className === "Warlock" && m.specName === specName);
  if (!model) throw new Error(`Model not found for spec=${specName}`);
  return buildNodeIndex(model);
}
function determineActiveHeroSubTreeId(model, selections) {
  const subTree = (model.subTreeNodes || []).find((x) => x.type === "subtree") || (model.subTreeNodes || [])[0];
  if (!subTree || !Array.isArray(subTree.entries)) return null;

  // entries: [{ name, traitSubTreeId, nodes:[...] }, ...]
  let best = { traitSubTreeId: null, score: -1 };

  for (const e of subTree.entries) {
    const nodeIds = Array.isArray(e.nodes) ? e.nodes : [];
    let score = 0;
    for (const id of nodeIds) {
      if (selections?.get(id)?.taken) score++;
    }
    if (score > best.score) best = { traitSubTreeId: e.traitSubTreeId, score };
  }

  // Если строка пустая или геройка не выбрана, score может быть 0 у всех
  if (best.score <= 0) return null;

  return best.traitSubTreeId;
}


// --------- decoder (best-effort, tweakable) ---------

function decodeToBits(code) {
  const bits = [];
  for (const ch of code.trim()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    // 6 bits, LSB-first
    for (let b = 0; b < 6; b++) bits.push((idx >> b) & 1);
  }
  return bits;
}

class BitReader {
  constructor(bits) {
    this.bits = bits;
    this.i = 0;
  }
  read(n) {
    let v = 0;
    for (let b = 0; b < n; b++) {
      v |= ((this.bits[this.i++] ?? 0) & 1) << b;
    }
    return v;
  }
  readVarInt() {
    let shift = 0;
    let out = 0;
    while (true) {
      const chunk = this.read(8);
      out |= (chunk & 0x7f) << shift;
      if ((chunk & 0x80) === 0) break;
      shift += 7;
    }
    return out;
  }
}

function bitsNeededForMaxRanks(maxRanks) {
  if (maxRanks <= 1) return 0;
  if (maxRanks <= 2) return 1; // 0..1 (+1)
  if (maxRanks <= 4) return 2; // 0..3 (+1)
  if (maxRanks <= 8) return 3;
  return 4;
}

function decodeSelections({ code, model, debug }) {
  const bits = decodeToBits(code);
  const br = new BitReader(bits);

  // Header skip (heuristic). If mismatch, adjust later.
  const h1 = br.readVarInt();
  const h2 = br.readVarInt();
  const h3 = br.readVarInt();
  const h4 = br.readVarInt();

  if (debug) {
    // eslint-disable-next-line no-console
    console.log("header varints:", { h1, h2, h3, h4 });
  }

  const byNodeId = new Map();

  for (const nodeId of model.fullNodeOrder || []) {
    const node = model._nodeIndex.get(nodeId);

    // Node exists in encoding even if not in the three arrays (class/spec/hero).
    // To keep alignment, we STILL have to consume bits for unknown nodes.
    const maxRanks = node?.maxRanks ?? 1;
    const nodeType = node?.type ?? "single";
    const taken = br.read(1) === 1;

    let ranksTaken = 0;
    let choiceEntryIndex = null;

    if (taken) {
      if (nodeType === "choice") {
        choiceEntryIndex = br.read(2);
        ranksTaken = 1;
      } else if (nodeType === "tiered") {
        // total ranks 0..7 stored in 3 bits in many exports
        ranksTaken = br.read(3);
        if (ranksTaken > maxRanks) ranksTaken = maxRanks;
      } else {
        const bn = bitsNeededForMaxRanks(maxRanks);
        ranksTaken = bn ? br.read(bn) + 1 : 1;
        if (ranksTaken > maxRanks) ranksTaken = maxRanks;
      }
    }

    if (node) {
      byNodeId.set(nodeId, { taken, ranksTaken, maxRanks, choiceEntryIndex });
    }
  }

  return byNodeId;
}

// --------- render ---------

function computeBounds(nodes) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const n of nodes) {
    minX = Math.min(minX, n.posX);
    minY = Math.min(minY, n.posY);
    maxX = Math.max(maxX, n.posX);
    maxY = Math.max(maxY, n.posY);
  }
  return { minX, minY, maxX, maxY };
}

function render(model, selections, svg, tooltipEl, heroSubTreeId) {
  svg.innerHTML = "";

  const W = 1200;
  const H = 820;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const activeHeroSubTreeId = determineActiveHeroSubTreeId(model, selections);

const heroNodesFiltered = (model.heroNodes || []).filter((n) => {
  if (!heroSubTreeId) return false; // если параметр hero не передали — центр пустой
  return n.subTreeId === heroSubTreeId;
});

const allNodes = [...(model.classNodes || []), ...heroNodesFiltered, ...(model.specNodes || [])];


  const bounds = computeBounds(allNodes);

  const pad = 60;
  const scaleX = (W - pad * 2) / (bounds.maxX - bounds.minX);
  const scaleY = (H - pad * 2) / (bounds.maxY - bounds.minY);
  const scale = Math.min(scaleX, scaleY);

  const toScreen = (x, y) => ({
    x: pad + (x - bounds.minX) * scale,
    y: pad + (y - bounds.minY) * scale
  });

  const isActive = (id) => selections?.get(id)?.taken === true;

  // edges
  const edgesG = elSvg("g");
  svg.appendChild(edgesG);

  for (const n of allNodes) {
    if (!Array.isArray(n.next)) continue;
    const a = toScreen(n.posX, n.posY);

    for (const toId of n.next) {
      const m = model._nodeIndex.get(toId);
      if (!m) continue;
      const b = toScreen(m.posX, m.posY);

      const active = isActive(n.id) && isActive(toId);

      edgesG.appendChild(
        elSvg("line", {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          class: `edge ${active ? "edge--active" : ""}`
        })
      );
    }
  }

  // nodes
  const nodesG = elSvg("g");
  svg.appendChild(nodesG);

  for (const n of allNodes) {
    const s = toScreen(n.posX, n.posY);
    const size = 44;
    const r = 10;

    const sel = selections?.get(n.id) || {
      taken: false,
      ranksTaken: 0,
      maxRanks: n.maxRanks ?? 1,
      choiceEntryIndex: null
    };

    // which entry to show for choice nodes
    let entry = n.entries?.[0] ?? null;
    if (n.type === "choice" && sel.taken && typeof sel.choiceEntryIndex === "number") {
      entry = n.entries?.[sel.choiceEntryIndex] ?? n.entries?.[0] ?? entry;
    }

    const iconUrl = wowheadIconUrl(entry?.icon);
    const maxRanks = n.maxRanks ?? 1;
    const label = `${sel.ranksTaken}/${maxRanks}`;

    const g = elSvg("g", {
      class: `node ${sel.taken ? "node--active" : "node--dim"}`,
      transform: `translate(${s.x - size / 2}, ${s.y - size / 2})`
    });

    g.appendChild(
      elSvg("rect", {
        x: 0,
        y: 0,
        width: size,
        height: size,
        rx: r,
        ry: r,
        class: "node__frame"
      })
    );

    if (iconUrl) {
      g.appendChild(
        elSvg("image", {
          href: iconUrl,
          x: 2,
          y: 2,
          width: size - 4,
          height: size - 4,
          preserveAspectRatio: "xMidYMid slice",
          class: "node__icon"
        })
      );
    }

    // rank badge
    const badgeW = 34;
    const badgeH = 16;

    g.appendChild(
      elSvg("rect", {
        x: size - badgeW - 3,
        y: size - badgeH - 3,
        width: badgeW,
        height: badgeH,
        rx: 6,
        ry: 6,
        class: "rank__bg"
      })
    );

    const t = elSvg("text", {
      x: size - badgeW / 2 - 3,
      y: size - 6,
      "text-anchor": "middle",
      class: "rank"
    });
    t.textContent = label;
    g.appendChild(t);

    // tooltip (only title)
    g.addEventListener("mousemove", (ev) => {
      const title = entry?.name ?? n.name ?? "Unknown";
      tooltipEl.innerHTML = `<div class="tooltip__title">${escapeHtml(title)}</div>`;
      tooltipEl.hidden = false;

      const rootRect = svg.getBoundingClientRect();
      const x = ev.clientX - rootRect.left + 12;
      const y = ev.clientY - rootRect.top + 12;
      tooltipEl.style.transform = `translate(${x}px, ${y}px)`;
    });

    g.addEventListener("mouseleave", () => {
      tooltipEl.hidden = true;
    });

    nodesG.appendChild(g);
  }
}

// --------- boot ---------

(async function main() {
  const svg = document.getElementById("talentSvg");
  const tooltipEl = document.getElementById("tooltip");

  const q = getQuery();
  const models = await loadModels();
  const model = pickModel(models, q.spec);

  let selections = new Map();
  if (q.code) {
    selections = decodeSelections({ code: q.code, model, debug: q.debug });
  }
  const heroSubTreeId = heroKeyToSubTreeId(q.hero);
  render(model, selections, svg, tooltipEl, heroSubTreeId);;
})();
