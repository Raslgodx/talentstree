const WOWHEAD_ICON_BASE = "https://wow.zamimg.com/images/wow/icons/large/";
const SVG_NS = "http://www.w3.org/2000/svg";

// --------- CALIBRATION (temporary, for cal=1) ---------
const CALIBRATION = {
  code: "CkQAAAAAAAAAAAAAAAAAAAAAAwMzYGNbjx2MzMzyAAAmZmlZbmZWGDAYBGY2MaMDIzCYZAAAwAAAzMYYMzsNzMzMMzMzMDzMzAAMAA",
  expectedTaken: new Set([
    // class (left)
    71931, 71933, 71949, 71948, 71922, 109847,
    // spec (right)
    72049, 72050, 72047, 72032, 109860, 72054, 110269, 72046, 109849, 72034, 109850, 109853
  ]),
  expectedHeroAll: true
};

// --------- helpers ---------
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
    hero: (u.searchParams.get("hero") || "").toLowerCase(),
    debug: u.searchParams.get("debug") === "1",
    cal: u.searchParams.get("cal") === "1"
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
  // per your JSON:
  // 57 = Soul Harvester, 58 = Hellcaller, 59 = Diabolist
  if (!heroKey) return null;
  const k = heroKey.toLowerCase();
  if (k === "soulharvester") return 57;
  if (k === "hellcaller") return 58;
  if (k === "diabolist") return 59;
  return null;
}

// --------- data/model ---------
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
  model._nodeIndex = idx;
  return model;
}

function pickModel(models, specKey) {
  const specName = specKeyToName(specKey);
  const model = models.find((m) => m.className === "Warlock" && m.specName === specName);
  if (!model) throw new Error(`Model not found for spec=${specName}`);
  return buildNodeIndex(model);
}

// --------- BYTE-BASED decoder (correct base64 -> bytes) ---------
function base64ToBytes(b64) {
  const clean = (b64 || "").trim();
  const padLen = (4 - (clean.length % 4)) % 4;
  const padded = clean + "=".repeat(padLen);

  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class ByteBitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.byteI = 0;
    this.bitI = 0; // 0..7, LSB-first within each byte
  }

  readBits(n) {
    let v = 0;
    for (let b = 0; b < n; b++) {
      const cur = this.bytes[this.byteI] ?? 0;
      const bit = (cur >> this.bitI) & 1;
      v |= bit << b;

      this.bitI++;
      if (this.bitI >= 8) {
        this.bitI = 0;
        this.byteI++;
      }
    }
    return v;
  }

  alignToByte() {
    if (this.bitI !== 0) {
      this.bitI = 0;
      this.byteI++;
    }
  }

  readVarInt() {
    // WoW varints are byte-aligned
    this.alignToByte();

    let shift = 0;
    let out = 0;
    while (true) {
      const byte = this.bytes[this.byteI++] ?? 0;
      out |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return out >>> 0;
  }

  bytesLeft() {
    return Math.max(0, this.bytes.length - this.byteI);
  }
}

function bitsNeededForMaxRanks(maxRanks) {
  if (maxRanks <= 1) return 0;
  if (maxRanks <= 2) return 1;
  if (maxRanks <= 4) return 2;
  if (maxRanks <= 8) return 3;
  return 4;
}

function decodeSelections({ code, model, debug, opts }) {
  const {
    headerVarInts = 0,
    choiceMode = "byEntryCount", // "byEntryCount" | "fixed1" | "fixed2"
    choiceExtraBit = false, // NEW: read +1 bit after choiceIndex (if taken)
    rankMode = "plus1" // "plus1" | "raw" | "tiered3"
  } = opts || {};

  const bytes = base64ToBytes(code);
  const br = new ByteBitReader(bytes);

  const header = [];
  for (let i = 0; i < headerVarInts; i++) header.push(br.readVarInt());

  if (debug) {
    console.log("header:", header, {
      headerVarInts,
      choiceMode,
      choiceExtraBit,
      rankMode,
      totalBytes: bytes.length
    });
  }

  const byNodeId = new Map();

  for (const nodeId of model.fullNodeOrder || []) {
    const node = model._nodeIndex.get(nodeId);

    // keep alignment even for unknown nodes
    const maxRanks = node?.maxRanks ?? 1;
    const nodeType = node?.type ?? "single";

    const taken = br.readBits(1) === 1;

    let ranksTaken = 0;
    let choiceEntryIndex = null;

    if (taken) {
      if (nodeType === "choice") {
        const entryCount = Array.isArray(node?.entries) ? node.entries.length : 2;

        let cb = 2;
        if (choiceMode === "fixed1") cb = 1;
        else if (choiceMode === "fixed2") cb = 2;
        else cb = entryCount <= 2 ? 1 : 2;

        choiceEntryIndex = br.readBits(cb);

        if (choiceExtraBit) br.readBits(1); // NEW

        ranksTaken = 1;
      } else {
        const bn = bitsNeededForMaxRanks(maxRanks);

        if (bn === 0) {
          ranksTaken = 1;
        } else if (rankMode === "raw") {
          ranksTaken = br.readBits(bn);
          if (ranksTaken <= 0) ranksTaken = 1;
          if (ranksTaken > maxRanks) ranksTaken = maxRanks;
        } else if (rankMode === "tiered3") {
          ranksTaken = br.readBits(3);
          if (ranksTaken <= 0) ranksTaken = 1;
          if (ranksTaken > maxRanks) ranksTaken = maxRanks;
        } else {
          ranksTaken = br.readBits(bn) + 1;
          if (ranksTaken > maxRanks) ranksTaken = maxRanks;
        }
      }
    }

    if (node) byNodeId.set(nodeId, { taken, ranksTaken, maxRanks, choiceEntryIndex });
  }

  if (debug) console.log("decode tail:", { bytesLeft: br.bytesLeft() });

  return byNodeId;
}

// --------- debug compare against calibration ---------
function debugCompareAgainstCalibration(selections) {
  const missing = [];
  const extra = [];

  for (const id of CALIBRATION.expectedTaken) {
    if (!selections.get(id)?.taken) missing.push(id);
  }
  for (const [id, s] of selections.entries()) {
    if (s?.taken && !CALIBRATION.expectedTaken.has(id)) extra.push(id);
  }

  console.log("CALIBRATION missing(expected but not taken):", missing);
  console.log(
    "CALIBRATION extra(taken but not expected):",
    extra.slice(0, 50),
    extra.length > 50 ? `(and ${extra.length - 50} more)` : ""
  );
}

// --------- calibration (cal=1) ---------
function scoreDecode(model, selections) {
  let score = 0;

  for (const id of CALIBRATION.expectedTaken) {
    const taken = selections.get(id)?.taken === true;
    score += taken ? 2 : -2;
  }

  if (CALIBRATION.expectedHeroAll) {
    const subTree = (model.subTreeNodes || [])[0];
    if (subTree?.entries?.length) {
      let best = { nodes: [], taken: -1, traitSubTreeId: null };

      for (const e of subTree.entries) {
        let cnt = 0;
        for (const nid of e.nodes || []) if (selections.get(nid)?.taken) cnt++;
        if (cnt > best.taken) best = { nodes: e.nodes || [], taken: cnt, traitSubTreeId: e.traitSubTreeId };
      }

      let all = true;
      for (const nid of best.nodes) {
        if (!selections.get(nid)?.taken) {
          all = false;
          break;
        }
      }
      score += all ? 10 : -10;
    }
  }

  return score;
}

function calibrateDecoder(model) {
  const candidates = [];

  const headerRange = Array.from({ length: 41 }, (_, i) => i); // 0..40
  const choiceModes = ["byEntryCount", "fixed1", "fixed2"];
  const choiceExtraBits = [false, true];
  const rankModes = ["plus1", "raw", "tiered3"];

  for (const headerVarInts of headerRange) {
    for (const choiceMode of choiceModes) {
      for (const choiceExtraBit of choiceExtraBits) {
        for (const rankMode of rankModes) {
          try {
            const selections = decodeSelections({
              code: CALIBRATION.code,
              model,
              debug: false,
              opts: { headerVarInts, choiceMode, choiceExtraBit, rankMode }
            });

            const score = scoreDecode(model, selections);
            candidates.push({ headerVarInts, choiceMode, choiceExtraBit, rankMode, score });
          } catch {
            // ignore
          }
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
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

  const heroNodesFiltered = (model.heroNodes || []).filter((n) => {
    if (!heroSubTreeId) return false; // if hero param not set -> hide center
    return n.subTreeId === heroSubTreeId;
  });

  const allNodes = [...(model.classNodes || []), ...heroNodesFiltered, ...(model.specNodes || [])];
  if (!allNodes.length) return;

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

      // do not draw edges that go to a hidden hero node
      if (m._tree === "hero" && heroSubTreeId && m.subTreeId !== heroSubTreeId) continue;

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
  if (q.debug) console.log("APP START", q);

  const models = await loadModels();
  const model = pickModel(models, q.spec);

  if (q.debug) {
    console.log("MODEL", {
      spec: q.spec,
      fullNodeOrder: model.fullNodeOrder?.length,
      classNodes: model.classNodes?.length,
      heroNodes: model.heroNodes?.length,
      specNodes: model.specNodes?.length
    });
  }

  // Default decoder params (baseline; will be overridden when cal=1 finds better)
  let decoderOpts = {
    headerVarInts: 0,
    choiceMode: "byEntryCount",
    choiceExtraBit: false,
    rankMode: "plus1"
  };

  if (q.cal) {
    const best = calibrateDecoder(model);
    console.log("BEST DECODER OPTS:", best);
    if (best) decoderOpts = best;
  }

  if (q.debug) console.log("DECODER OPTS USED:", decoderOpts);

  let selections = new Map();
  if (q.code) {
    selections = decodeSelections({ code: q.code, model, debug: q.debug, opts: decoderOpts });
  }

  if (q.debug && q.code === CALIBRATION.code) {
    debugCompareAgainstCalibration(selections);
  }

  if (q.debug) {
    const takenCount = [...selections.values()].filter((s) => s?.taken).length;
    console.log("TAKEN COUNT:", takenCount);
  }

  const heroSubTreeId = heroKeyToSubTreeId(q.hero);
  render(model, selections, svg, tooltipEl, heroSubTreeId);
})().catch((e) => {
  console.error("APP CRASH:", e);
});
