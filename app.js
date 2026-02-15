const WOWHEAD_ICON_BASE = "https://wow.zamimg.com/images/wow/icons/large/";
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * WoW talent string decoding:
 * - These strings are base64-like and contain a bitstream.
 * - Implementing a 100% correct decoder for all future changes is non-trivial,
 *   but for Dragonflight/War Within it follows a known bitpacking scheme:
 *   header + selection list, with per-node ranks and choice selections.
 *
 * This implementation is pragmatic:
 * - We decode to a bitstream (6-bit alphabet).
 * - Then parse using the node order from JSON (fullNodeOrder),
 *   reading per-node:
 *   - taken flag
 *   - ranks (0..maxRanks)
 *   - choice index for 'choice' nodes
 *   - tiered handling via entries maxRanks sum
 *
 * If your JSON matches the same packing that produced these strings, it will work.
 * If not, we can adjust the parser once you confirm any mismatches on a few builds.
 */

// Blizzard/WoW export alphabet (base64url-like) used by talent strings
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeToBits(code) {
  const bits = [];
  for (const ch of code.trim()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    // 6 bits, least-significant bit first (common for WoW export)
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
      if (this.i >= this.bits.length) return v;
      v |= (this.bits[this.i++] & 1) << b;
    }
    return v;
  }
  // Variable-length int (7-bit groups). Used in many Blizzard bitstreams.
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

/**
 * NOTE:
 * The very beginning of the string contains metadata (tree/spec, etc.).
 * We skip a small header heuristically by reading a couple varints.
 * This is the only "guessy" part. If your builds don't match, we tweak skip.
 */
function decodeSelections({ code, model }) {
  const bits = decodeToBits(code);
  const br = new BitReader(bits);

  // Heuristic header skip:
  // In practice, these exports start with 2-4 varints / small fields.
  // We'll consume 4 varints to land at selections stream.
  // If mismatches happen, we'll adjust.
  br.readVarInt();
  br.readVarInt();
  br.readVarInt();
  br.readVarInt();

  const byNodeId = new Map();

  const nodeIds = model.fullNodeOrder.filter((id) => typeof id === "number");

  for (const nodeId of nodeIds) {
    const node = model._nodeIndex.get(nodeId);
    if (!node) continue;

    const maxRanks = node.maxRanks ?? 1;

    // taken flag
    const taken = br.read(1) === 1;

    let ranksTaken = 0;
    let choiceEntryIndex = null;

    if (taken) {
      if (node.type === "choice") {
        // rank is always 1 for choice in your JSON; choose entry 0/1 (or more)
        // read 2 bits (supports up to 4 options, enough here)
        choiceEntryIndex = br.read(2);
        ranksTaken = 1;
      } else if (node.type === "tiered") {
        // tiered: total ranks distributed among entries; we read 3 bits per total rank (0..7)
        // but in your JSON maxRanks is 4 and entries maxRanks sum=4. We'll read 3 bits.
        ranksTaken = br.read(3);
        if (ranksTaken > maxRanks) ranksTaken = maxRanks;
      } else {
        // single: ranks (max 2 fits in 2 bits; max 3 fits in 2 bits; use 3 bits safe)
        const bitsNeeded = maxRanks <= 1 ? 0 : maxRanks <= 2 ? 1 : maxRanks <= 4 ? 2 : 3;
        ranksTaken = bitsNeeded ? br.read(bitsNeeded) + 1 : 1;
        if (ranksTaken > maxRanks) ranksTaken = maxRanks;
      }
    }

    byNodeId.set(nodeId, {
      taken,
      ranksTaken,
      maxRanks,
      choiceEntryIndex
    });
  }

  return byNodeId;
}

function wowheadIconUrl(iconName) {
  if (!iconName) return null;
  return `${WOWHEAD_ICON_BASE}${iconName.toLowerCase()}.jpg`;
}

function elSvg(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function buildNodeIndex(model) {
  const idx = new Map();
  for (const n of model.classNodes) idx.set(n.id, { ...n, _tree: "class" });
  for (const n of model.specNodes) idx.set(n.id, { ...n, _tree: "spec" });
  for (const n of model.heroNodes) idx.set(n.id, { ...n, _tree: "hero" });
  model._nodeIndex = idx;
  return model;
}

function computeBounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.posX);
    minY = Math.min(minY, n.posY);
    maxX = Math.max(maxX, n.posX);
    maxY = Math.max(maxY, n.posY);
  }
  return { minX, minY, maxX, maxY };
}

function render(model, selections, svg, tooltipEl) {
  svg.innerHTML = "";

  const W = 1200;
  const H = 820;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const allNodes = [...model.classNodes, ...model.heroNodes, ...model.specNodes];

  // Layout mapping:
  // JSON posX is in a bigger coordinate system. Normalize into our 1200x820.
  const bounds = computeBounds(allNodes);

  const pad = 60;
  const scaleX = (W - pad * 2) / (bounds.maxX - bounds.minX);
  const scaleY = (H - pad * 2) / (bounds.maxY - bounds.minY);
  const scale = Math.min(scaleX, scaleY);

  const toScreen = (x, y) => ({
    x: pad + (x - bounds.minX) * scale,
    y: pad + (y - bounds.minY) * scale
  });

  // edges
  const edgesG = elSvg("g");
  svg.appendChild(edgesG);

  const isActive = (id) => selections?.get(id)?.taken === true;

  for (const n of allNodes) {
    if (!Array.isArray(n.next)) continue;
    const a = toScreen(n.posX, n.posY);
    for (const toId of n.next) {
      const m = model._nodeIndex.get(toId);
      if (!m) continue;
      const b = toScreen(m.posX, m.posY);
      const line = elSvg("line", {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        class: `edge ${isActive(n.id) && isActive(toId) ? "edge--active" : ""}`
      });
      edgesG.appendChild(line);
    }
  }

  // nodes
  const nodesG = elSvg("g");
  svg.appendChild(nodesG);

  for (const n of allNodes) {
    const s = toScreen(n.posX, n.posY);
    const size = 44;
    const r = 10;

    const sel = selections?.get(n.id) || { taken: false, ranksTaken: 0, maxRanks: n.maxRanks ?? 1, choiceEntryIndex: null };

    // Which entry to show (choice nodes can have 2 entries)
    let entry = n.entries?.[0] ?? null;
    if (n.type === "choice" && sel.taken && typeof sel.choiceEntryIndex === "number") {
      entry = n.entries?.[sel.choiceEntryIndex] ?? n.entries?.[0] ?? entry;
    }

    const iconUrl = wowheadIconUrl(entry?.icon);

    const g = elSvg("g", {
      class: `node ${sel.taken ? "node--active" : "node--dim"}`,
      transform: `translate(${s.x - size / 2}, ${s.y - size / 2})`
    });

    const frame = elSvg("rect", {
      x: 0,
      y: 0,
      width: size,
      height: size,
      rx: r,
      ry: r,
      class: "node__frame"
    });
    g.appendChild(frame);

    if (iconUrl) {
      const img = elSvg("image", {
        href: iconUrl,
        x: 2,
        y: 2,
        width: size - 4,
        height: size - 4,
        preserveAspectRatio: "xMidYMid slice",
        class: "node__icon"
      });
      g.appendChild(img);
    }

    // rank badge
    const maxRanks = n.maxRanks ?? 1;
    const label = `${sel.ranksTaken}/${maxRanks}`;

    const badgeW = 34;
    const badgeH = 16;

    const bg = elSvg("rect", {
      x: size - badgeW - 3,
      y: size - badgeH - 3,
      width: badgeW,
      height: badgeH,
      rx: 6,
      ry: 6,
      class: "rank__bg"
    });
    g.appendChild(bg);

    const text = elSvg("text", {
      x: size - badgeW / 2 - 3,
      y: size - 6,
      "text-anchor": "middle",
      class: "rank"
    });
    text.textContent = label;
    g.appendChild(text);

    // tooltip
    g.addEventListener("mousemove", (ev) => {
      const title = entry?.name ?? n.name ?? "Unknown";
      tooltipEl.innerHTML = `
        <div class="tooltip__title">${escapeHtml(title)}</div>
        <div class="tooltip__meta">${n._tree.toUpperCase()} • Node ${n.id}</div>
      `;
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function specKeyToName(key) {
  const k = (key || "").toLowerCase();
  if (k === "affliction") return "Affliction";
  if (k === "demonology") return "Demonology";
  if (k === "destruction") return "Destruction";
  return "Affliction";
}

async function loadModels() {
  const res = await fetch("./talents.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load talents.json");
  const arr = await res.json();
  return arr;
}

function pickModel(models, specKey) {
  const specName = specKeyToName(specKey);
  const model = models.find((m) => m.className === "Warlock" && m.specName === specName);
  if (!model) throw new Error(`Model not found for spec=${specName}`);
  return buildNodeIndex(model);
}

function getQuery() {
  const u = new URL(window.location.href);
  return {
    spec: u.searchParams.get("spec") || "affliction",
    code: u.searchParams.get("code") || ""
  };
}

function setQuery(spec, code) {
  const u = new URL(window.location.href);
  u.searchParams.set("spec", spec);
  if (code) u.searchParams.set("code", code);
  else u.searchParams.delete("code");
  history.replaceState(null, "", u.toString());
}

(async function main() {
  const svg = document.getElementById("talentSvg");
  const tooltipEl = document.getElementById("tooltip");
  const specSelect = document.getElementById("specSelect");
  const codeInput = document.getElementById("codeInput");
  const renderBtn = document.getElementById("renderBtn");

  const models = await loadModels();

  const q = getQuery();
  specSelect.value = (q.spec || "affliction").toLowerCase();
  codeInput.value = q.code || "";

  function doRender() {
    const spec = specSelect.value;
    const code = codeInput.value.trim();
    setQuery(spec, code);

    const model = pickModel(models, spec);

    let selections = new Map();
    if (code) {
      try {
        selections = decodeSelections({ code, model });
      } catch (e) {
        console.error(e);
        selections = new Map();
      }
    }

    render(model, selections, svg, tooltipEl);
  }

  renderBtn.addEventListener("click", doRender);
  specSelect.addEventListener("change", doRender);

  doRender();
})();
