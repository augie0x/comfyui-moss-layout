// Visual layout editor embedded in the "MOSS Layout Generate" node.
// State is kept as JSON in the node's hidden `layout_json` widget.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "MossLayoutGenerate";
const MIN_EDGE = 256;
const MAX_PIXELS = 1572864;
const TYPES = { object: "#2f6fb5", character: "#9a5f1d", text: "#8a3f9a" };
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_BOX = 16;

const CSS = `
.moss-ed{font:12px sans-serif;color:#e6e6ef;display:flex;flex-direction:column;gap:6px;width:100%;height:100%;box-sizing:border-box;padding:4px;overflow:auto}
.moss-ed *{box-sizing:border-box}
.moss-ed label{display:flex;flex-direction:column;gap:2px;font-weight:600}
.moss-ed input,.moss-ed select,.moss-ed textarea{background:#3a3d4a;color:#e6e6ef;border:1px solid #4a4e5e;border-radius:4px;padding:4px 6px;font:inherit;width:100%}
.moss-ed textarea{resize:vertical;min-height:44px}
.moss-ed button{background:#3a3d4a;color:#e6e6ef;border:1px solid #4a4e5e;border-radius:4px;padding:5px 9px;font-weight:600;cursor:pointer}
.moss-ed button.on{background:#4f46e5;border-color:#6b64f0}
.moss-ed .row{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap}
.moss-ed .row>label{flex:1;min-width:70px}
.moss-ed .main{display:flex;gap:6px;flex:1;min-height:300px}
.moss-ed .stage{flex:1;min-width:240px;background:#262629;border:1px solid #3a3d4a;border-radius:6px;display:flex;align-items:center;justify-content:center;padding:8px;overflow:hidden}
.moss-ed canvas{max-width:100%;max-height:100%;background:#fff;touch-action:none}
.moss-ed .panel{width:190px;flex:none;background:#1f2230;border:1px solid #3a3d4a;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px;overflow:auto}
.moss-ed .panel.off{opacity:.45;pointer-events:none}
.moss-ed .status{opacity:.7}
.moss-ed details{background:#1f2230;border:1px solid #3a3d4a;border-radius:6px;padding:6px 8px}
.moss-ed summary{cursor:pointer;font-weight:600}
.moss-ed details textarea{font-family:monospace;min-height:110px;margin:6px 0}
`;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    kids.forEach((k) => e.append(k));
    return e;
}

function buildEditor(node, dataWidget) {
    if (!document.getElementById("moss-ed-css")) {
        document.head.append(el("style", { id: "moss-ed-css", textContent: CSS }));
    }

    let state = { width: 1024, height: 1024, summary: { caption: "" }, items: [] };
    try {
        const parsed = JSON.parse(dataWidget.value);
        if (parsed && parsed.width) state = { ...state, ...parsed };
    } catch (e) { /* keep defaults */ }
    const ui = { mode: "select", grid: true, snap: true, gridSize: 32, newType: "object", sel: -1 };
    let undo = [], redo = [];
    let drag = null;

    const snapshot = () => JSON.stringify({ width: state.width, height: state.height, summary: state.summary, items: state.items });
    let lastSnap = snapshot();

    const commit = (record = true) => {
        if (record) {
            undo.push(lastSnap);
            if (undo.length > 100) undo.shift();
            redo = [];
        }
        lastSnap = snapshot();
        dataWidget.value = lastSnap;
        app.graph.setDirtyCanvas(true, true);
    };
    const restore = (json) => {
        const s = JSON.parse(json);
        state.width = s.width; state.height = s.height; state.summary = s.summary; state.items = s.items;
        if (ui.sel >= state.items.length) ui.sel = -1;
        lastSnap = json;
        dataWidget.value = json;
        syncAll();
    };

    // ---- DOM ------------------------------------------------------------
    const wIn = el("input", { type: "number", step: 16 });
    const hIn = el("input", { type: "number", step: 16 });
    const typeSel = el("select");
    Object.keys(TYPES).forEach((t) => typeSel.append(el("option", { value: t, textContent: t[0].toUpperCase() + t.slice(1) })));
    const gridIn = el("input", { type: "number", min: 4, step: 4 });
    const gridBtn = el("button", { textContent: "Show grid" });
    const snapBtn = el("button", { textContent: "Snap to grid" });
    const scene = el("textarea", { placeholder: "Overall scene prompt (required)", rows: 2 });

    const drawBtn = el("button", { textContent: "Draw boxes" });
    const selBtn = el("button", { textContent: "Select" });
    const undoBtn = el("button", { textContent: "Undo" });
    const redoBtn = el("button", { textContent: "Redo" });
    const dupBtn = el("button", { textContent: "Duplicate" });
    const delBtn = el("button", { textContent: "Delete" });
    const clearBtn = el("button", { textContent: "Clear" });

    const tplSel = el("select");
    tplSel.append(el("option", { value: "", textContent: "Choose a template (loading...)" }));
    const tplBtn = el("button", { textContent: "Use template" });
    const tplSaveBtn = el("button", { textContent: "Save as template" });
    const tplDelBtn = el("button", { textContent: "Delete template", disabled: true });
    const saveName = el("input", { placeholder: "Template name" });
    const saveCat = el("select");
    const saveNewCat = el("input", { placeholder: "New category name" });
    const saveOk = el("button", { textContent: "Save", className: "on" });
    const saveCancel = el("button", { textContent: "Cancel" });
    const saveMsg = el("span", { className: "status" });
    const newCatLabel = el("label", { style: "display:none" }, "New category", saveNewCat);
    const saveForm = el("div", { className: "row", style: "display:none" },
        el("label", {}, "Template name", saveName), el("label", {}, "Category", saveCat), newCatLabel, saveOk, saveCancel);
    const tplMsg = el("div", { className: "status" });
    const jsonArea = el("textarea", { spellcheck: false });
    const jsonRefresh = el("button", { textContent: "Refresh JSON" });
    const jsonLoad = el("button", { textContent: "Load JSON into editor" });
    const jsonMsg = el("span", { className: "status" });
    const jsonBox = el("details", {}, el("summary", {}, "Layout JSON (editable draft)"), jsonArea,
        el("div", { className: "row" }, jsonRefresh, jsonLoad, jsonMsg));

    const canvas = el("canvas");
    const ctx = canvas.getContext("2d");
    const stage = el("div", { className: "stage" }, canvas);

    const pTitle = el("div", { style: "font-size:13px" });
    const pType = el("select");
    Object.keys(TYPES).forEach((t) => pType.append(el("option", { value: t, textContent: t[0].toUpperCase() + t.slice(1) })));
    const pX = el("input", { type: "number" }), pY = el("input", { type: "number" });
    const pW = el("input", { type: "number" }), pH = el("input", { type: "number" });
    const pCap = el("textarea", { placeholder: "Region prompt", rows: 4 });
    const pTxt = el("textarea", { placeholder: "Characters the model should render", rows: 3 });
    const panel = el("div", { className: "panel off" },
        pTitle,
        el("label", {}, "Type", pType),
        el("div", { className: "row" }, el("label", {}, "X", pX), el("label", {}, "Y", pY)),
        el("div", { className: "row" }, el("label", {}, "Width", pW), el("label", {}, "Height", pH)),
        el("label", {}, "Region prompt", pCap),
        el("label", {}, "Exact visible text", pTxt));
    const status = el("div", { className: "status" });

    const root = el("div", { className: "moss-ed" },
        el("div", { className: "row" },
            el("label", {}, "Canvas width", wIn), el("label", {}, "Canvas height", hIn),
            el("label", {}, "New box type", typeSel), el("label", {}, "Grid size", gridIn), gridBtn, snapBtn),
        el("label", {}, "Overall scene prompt", scene),
        el("div", { className: "row" }, drawBtn, selBtn, undoBtn, redoBtn, dupBtn, delBtn, clearBtn),
        el("div", { className: "row" }, el("label", {}, "Templates", tplSel), tplBtn, tplSaveBtn, tplDelBtn),
        saveForm, el("div", { className: "row" }, saveMsg), tplMsg,
        el("div", { className: "main" }, stage, panel),
        status, jsonBox);

    // ---- geometry / sync -------------------------------------------------
    const snapV = (v) => (ui.snap ? Math.round(v / ui.gridSize) * ui.gridSize : Math.round(v));
    const sel = () => state.items[ui.sel];

    function normBox(b) {
        let [l, t, r, bo] = b;
        l = clamp(Math.round(l), 0, state.width - MIN_BOX);
        t = clamp(Math.round(t), 0, state.height - MIN_BOX);
        r = clamp(Math.round(r), l + MIN_BOX, state.width);
        bo = clamp(Math.round(bo), t + MIN_BOX, state.height);
        return [l, t, r, bo];
    }

    function syncCanvasSize() {
        canvas.width = state.width;
        canvas.height = state.height;
        canvas.style.aspectRatio = `${state.width} / ${state.height}`;
    }

    function syncPanel() {
        const it = sel();
        panel.classList.toggle("off", !it);
        if (!it) {
            pTitle.textContent = "No box selected";
            status.textContent = `${state.items.length} box(es) · ${state.width}×${state.height}`;
            return;
        }
        const [l, t, r, b] = it.bbox;
        pTitle.textContent = `BBOX ${ui.sel + 1}`;
        pType.value = it.label;
        pX.value = l; pY.value = t; pW.value = r - l; pH.value = b - t;
        if (document.activeElement !== pCap) pCap.value = it.caption;
        if (document.activeElement !== pTxt) pTxt.value = it.text || "";
        status.textContent = `BBOX ${ui.sel + 1}: x ${l}, y ${t}, ${r - l} × ${b - t} px`;
    }

    function syncToolbar() {
        wIn.value = state.width; hIn.value = state.height;
        gridIn.value = ui.gridSize; typeSel.value = ui.newType;
        if (document.activeElement !== scene) scene.value = state.summary.caption || "";
        gridBtn.classList.toggle("on", ui.grid);
        snapBtn.classList.toggle("on", ui.snap);
        drawBtn.classList.toggle("on", ui.mode === "draw");
        selBtn.classList.toggle("on", ui.mode === "select");
        undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
        canvas.style.cursor = ui.mode === "draw" ? "crosshair" : "default";
    }

    function syncAll() { syncCanvasSize(); syncToolbar(); syncPanel(); render(); }

    // ---- drawing ----------------------------------------------------------
    function wrapText(text, maxW) {
        const lines = [];
        for (const para of String(text).split("\n")) {
            let line = "";
            for (const word of para.split(/(\s+)/)) {
                const test = line + word;
                if (line && ctx.measureText(test).width > maxW) { lines.push(line.trimEnd()); line = word.trimStart(); }
                else line = test;
            }
            lines.push(line);
        }
        return lines;
    }

    function render() {
        const cssScale = canvas.clientWidth ? canvas.clientWidth / state.width : 0.5;
        const k = 1 / Math.max(cssScale, 0.05); // logical px per CSS px
        ctx.clearRect(0, 0, state.width, state.height);
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, state.width, state.height);
        if (ui.grid) {
            ctx.lineWidth = k; ctx.strokeStyle = "rgba(120,160,210,.25)"; ctx.beginPath();
            for (let x = 0; x <= state.width; x += ui.gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, state.height); }
            for (let y = 0; y <= state.height; y += ui.gridSize) { ctx.moveTo(0, y); ctx.lineTo(state.width, y); }
            ctx.stroke();
        }
        ctx.strokeStyle = "rgba(220,80,80,.45)"; ctx.lineWidth = k; ctx.beginPath();
        ctx.moveTo(state.width / 2, 0); ctx.lineTo(state.width / 2, state.height);
        ctx.moveTo(0, state.height / 2); ctx.lineTo(state.width, state.height / 2);
        ctx.stroke();

        const fs = 12 * k;
        state.items.forEach((it, i) => {
            const [l, t, r, b] = it.bbox;
            const color = TYPES[it.label] || TYPES.object;
            ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(l, t, r - l, b - t);
            ctx.lineWidth = (i === ui.sel ? 2.5 : 1.5) * k;
            ctx.strokeStyle = color; ctx.strokeRect(l, t, r - l, b - t);
            ctx.font = `600 ${fs}px sans-serif`;
            const tag = `BBOX ${i + 1} · ${it.label[0].toUpperCase() + it.label.slice(1)}`;
            const tw = Math.min(ctx.measureText(tag).width + 8 * k, r - l);
            ctx.fillStyle = color; ctx.fillRect(l, t, tw, fs + 6 * k);
            ctx.fillStyle = "#fff"; ctx.textBaseline = "top"; ctx.fillText(tag, l + 4 * k, t + 3 * k, tw - 6 * k);
            ctx.save(); ctx.beginPath(); ctx.rect(l, t, r - l, b - t); ctx.clip();
            ctx.font = `${fs}px sans-serif`; ctx.fillStyle = it.caption ? "#222" : "#888";
            const body = it.caption || "Optional region prompt...";
            wrapText(body, r - l - 10 * k).forEach((ln, j) => ctx.fillText(ln, l + 5 * k, t + fs + 12 * k + j * fs * 1.25));
            ctx.restore();
            if (i === ui.sel) {
                ctx.fillStyle = "#fff"; ctx.strokeStyle = color; ctx.lineWidth = k;
                for (const h of HANDLES) {
                    const [hx, hy] = handlePos(it.bbox, h);
                    ctx.fillRect(hx - 4 * k, hy - 4 * k, 8 * k, 8 * k);
                    ctx.strokeRect(hx - 4 * k, hy - 4 * k, 8 * k, 8 * k);
                }
            }
        });
        if (drag && drag.kind === "draw" && drag.box) {
            const [l, t, r, b] = drag.box;
            ctx.setLineDash([6 * k, 4 * k]); ctx.lineWidth = 1.5 * k;
            ctx.strokeStyle = TYPES[ui.newType]; ctx.strokeRect(l, t, r - l, b - t); ctx.setLineDash([]);
        }
        undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
    }

    function handlePos([l, t, r, b], h) {
        const cx = (l + r) / 2, cy = (t + b) / 2;
        return { nw: [l, t], n: [cx, t], ne: [r, t], e: [r, cy], se: [r, b], s: [cx, b], sw: [l, b], w: [l, cy] }[h];
    }

    // ---- pointer interaction ---------------------------------------------
    function toLogical(e) {
        const rect = canvas.getBoundingClientRect();
        return [((e.clientX - rect.left) / rect.width) * state.width, ((e.clientY - rect.top) / rect.height) * state.height];
    }

    function hitHandle(x, y) {
        const it = sel();
        if (!it) return null;
        const tol = 9 / Math.max(canvas.clientWidth / state.width, 0.05);
        for (const h of HANDLES) {
            const [hx, hy] = handlePos(it.bbox, h);
            if (Math.abs(x - hx) <= tol && Math.abs(y - hy) <= tol) return h;
        }
        return null;
    }

    function hitBox(x, y) {
        for (let i = state.items.length - 1; i >= 0; i--) {
            const [l, t, r, b] = state.items[i].bbox;
            if (x >= l && x <= r && y >= t && y <= b) return i;
        }
        return -1;
    }

    canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault(); canvas.setPointerCapture(e.pointerId);
        const [x, y] = toLogical(e);
        if (ui.mode === "draw") {
            drag = { kind: "draw", x0: snapV(x), y0: snapV(y), box: null };
            return;
        }
        const h = hitHandle(x, y);
        if (h) { drag = { kind: "resize", h, orig: [...sel().bbox] }; return; }
        const i = hitBox(x, y);
        ui.sel = i;
        if (i >= 0) drag = { kind: "move", sx: x, sy: y, orig: [...state.items[i].bbox] };
        syncPanel(); render();
    });

    canvas.addEventListener("pointermove", (e) => {
        const [x, y] = toLogical(e);
        if (!drag) {
            if (ui.mode === "select") {
                const h = hitHandle(x, y);
                canvas.style.cursor = h ? `${h}-resize` : hitBox(x, y) >= 0 ? "move" : "default";
            }
            return;
        }
        if (drag.kind === "draw") {
            const x1 = snapV(x), y1 = snapV(y);
            drag.box = [Math.min(drag.x0, x1), Math.min(drag.y0, y1), Math.max(drag.x0, x1), Math.max(drag.y0, y1)];
        } else if (drag.kind === "move") {
            const [l, t, r, b] = drag.orig;
            const w = r - l, hgt = b - t;
            const nl = clamp(snapV(l + x - drag.sx), 0, state.width - w);
            const nt = clamp(snapV(t + y - drag.sy), 0, state.height - hgt);
            sel().bbox = [nl, nt, nl + w, nt + hgt];
            drag.moved = true;
        } else if (drag.kind === "resize") {
            let [l, t, r, b] = drag.orig;
            const sx = snapV(x), sy = snapV(y);
            if (drag.h.includes("w")) l = Math.min(sx, r - MIN_BOX);
            if (drag.h.includes("e")) r = Math.max(sx, l + MIN_BOX);
            if (drag.h.includes("n")) t = Math.min(sy, b - MIN_BOX);
            if (drag.h.includes("s")) b = Math.max(sy, t + MIN_BOX);
            sel().bbox = normBox([l, t, r, b]);
            drag.moved = true;
        }
        syncPanel(); render();
    });

    const endDrag = () => {
        if (!drag) return;
        const d = drag; drag = null;
        if (d.kind === "draw" && d.box && d.box[2] - d.box[0] >= MIN_BOX && d.box[3] - d.box[1] >= MIN_BOX) {
            undo.push(lastSnap); redo = [];
            state.items.push({ label: ui.newType, caption: "", text: "", bbox: normBox(d.box) });
            ui.sel = state.items.length - 1;
            commit(false);
            ui.mode = "select";
        } else if (d.moved) {
            const after = snapshot();
            const orig = d.orig;
            // record the pre-drag state for undo
            const prev = JSON.parse(lastSnap);
            if (prev.items[ui.sel]) prev.items[ui.sel].bbox = orig;
            undo.push(JSON.stringify(prev)); redo = [];
            lastSnap = after; dataWidget.value = after; app.graph.setDirtyCanvas(true, true);
        }
        syncToolbar(); syncPanel(); render();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    // ---- controls -----------------------------------------------------------
    drawBtn.onclick = () => { ui.mode = "draw"; syncToolbar(); };
    selBtn.onclick = () => { ui.mode = "select"; syncToolbar(); };
    undoBtn.onclick = () => { if (!undo.length) return; redo.push(lastSnap); restore(undo.pop()); };
    redoBtn.onclick = () => { if (!redo.length) return; undo.push(lastSnap); restore(redo.pop()); };
    dupBtn.onclick = () => {
        const it = sel(); if (!it) return;
        const [l, t, r, b] = it.bbox, off = ui.gridSize;
        const nb = normBox([l + off, t + off, r + off, b + off]);
        state.items.push({ ...it, bbox: nb });
        ui.sel = state.items.length - 1; commit(); syncPanel(); render();
    };
    delBtn.onclick = () => {
        if (ui.sel < 0) return;
        state.items.splice(ui.sel, 1); ui.sel = -1; commit(); syncPanel(); render(); syncToolbar();
    };
    clearBtn.onclick = () => {
        if (!state.items.length) return;
        state.items = []; ui.sel = -1; commit(); syncPanel(); render(); syncToolbar();
    };
    gridBtn.onclick = () => { ui.grid = !ui.grid; syncToolbar(); render(); };
    snapBtn.onclick = () => { ui.snap = !ui.snap; syncToolbar(); };
    gridIn.onchange = () => { ui.gridSize = clamp(parseInt(gridIn.value) || 32, 4, 256); syncToolbar(); render(); };
    typeSel.onchange = () => { ui.newType = typeSel.value; };

    function setCanvas(w, h, changed) {
        w = clamp(Math.round(w / 16) * 16, MIN_EDGE, 4096);
        h = clamp(Math.round(h / 16) * 16, MIN_EDGE, 4096);
        while (w * h > MAX_PIXELS) {
            if (changed === "w") h -= 16; else w -= 16;
        }
        state.width = w; state.height = h;
        state.items.forEach((it) => { it.bbox = normBox(it.bbox); });
        commit(); syncAll();
    }
    wIn.onchange = () => setCanvas(parseInt(wIn.value) || state.width, state.height, "w");
    hIn.onchange = () => setCanvas(state.width, parseInt(hIn.value) || state.height, "h");

    scene.oninput = () => { state.summary.caption = scene.value; lastSnap = snapshot(); dataWidget.value = lastSnap; };
    scene.onchange = () => { commit(false); };

    // text edits are saved live; one undo step per edit session via `change`
    let preEdit = null;
    const textEdit = (field) => (inp) => {
        inp.addEventListener("focus", () => { preEdit = lastSnap; });
        inp.addEventListener("input", () => {
            const it = sel(); if (!it) return;
            it[field] = inp.value; lastSnap = snapshot(); dataWidget.value = lastSnap; render();
        });
        inp.addEventListener("change", () => {
            if (preEdit && preEdit !== lastSnap) { undo.push(preEdit); redo = []; }
            preEdit = null; syncToolbar();
        });
    };
    textEdit("caption")(pCap); textEdit("text")(pTxt);
    scene.addEventListener("focus", () => { preEdit = lastSnap; });
    scene.addEventListener("change", () => {
        if (preEdit && preEdit !== lastSnap) { undo.push(preEdit); redo = []; }
        preEdit = null; syncToolbar();
    });

    pType.onchange = () => { const it = sel(); if (it) { it.label = pType.value; commit(); render(); } };
    const geom = () => {
        const it = sel(); if (!it) return;
        const l = parseInt(pX.value) || 0, t = parseInt(pY.value) || 0;
        it.bbox = normBox([l, t, l + (parseInt(pW.value) || MIN_BOX), t + (parseInt(pH.value) || MIN_BOX)]);
        commit(); syncPanel(); render();
    };
    [pX, pY, pW, pH].forEach((i) => { i.onchange = geom; });

    // ---- templates & JSON import/export ----------------------------------
    let templates = {};
    let categories = [];
    const NEW_CAT = "__new__";

    function fillTemplates(catalog, select) {
        templates = {};
        categories = catalog.map((c) => ({ id: c.id, name: c.name }));
        tplSel.innerHTML = "";
        tplSel.append(el("option", { value: "", textContent: "Choose a template" }));
        for (const cat of catalog) {
            const group = el("optgroup", { label: cat.name });
            for (const t of cat.templates) {
                const key = `${cat.id}/${t.id}`;
                templates[key] = t;
                group.append(el("option", { value: key, textContent: t.user ? `${t.name} (saved)` : t.name }));
            }
            tplSel.append(group);
        }
        if (select && templates[select]) tplSel.value = select;
        tplDelBtn.disabled = !templates[tplSel.value]?.user;
    }

    function loadTemplates(select) {
        return api.fetchApi("/moss_layout/templates").then((r) => r.json())
            .then((catalog) => fillTemplates(catalog, select))
            .catch(() => { tplSel.innerHTML = ""; tplSel.append(el("option", { value: "", textContent: "Templates unavailable" })); });
    }
    loadTemplates();
    // Other editor nodes refresh their lists when one saves or deletes a template.
    const onCatalogChanged = () => loadTemplates(tplSel.value);
    window.addEventListener("moss-templates-changed", onCatalogChanged);
    root._dispose = () => window.removeEventListener("moss-templates-changed", onCatalogChanged);

    tplSel.onchange = () => { tplDelBtn.disabled = !templates[tplSel.value]?.user; tplMsg.textContent = ""; };

    function openSaveForm() {
        saveCat.innerHTML = "";
        for (const c of categories) saveCat.append(el("option", { value: c.id, textContent: c.name }));
        saveCat.append(el("option", { value: NEW_CAT, textContent: "+ New category..." }));
        const current = templates[tplSel.value];
        const [curCat] = tplSel.value.split("/");
        if (current?.user) { saveName.value = current.name; saveCat.value = curCat; }
        else { saveName.value = ""; if (curCat && categories.some((c) => c.id === curCat)) saveCat.value = curCat; }
        if (!categories.length) saveCat.value = NEW_CAT;
        saveNewCat.value = "";
        newCatLabel.style.display = saveCat.value === NEW_CAT ? "" : "none";
        saveMsg.textContent = "";
        saveForm.style.display = "";
        saveName.focus();
    }
    const closeSaveForm = () => { saveForm.style.display = "none"; };
    saveCat.onchange = () => { newCatLabel.style.display = saveCat.value === NEW_CAT ? "" : "none"; };
    tplSaveBtn.onclick = () => (saveForm.style.display === "none" ? openSaveForm() : closeSaveForm());
    saveCancel.onclick = () => { closeSaveForm(); saveMsg.textContent = ""; };

    async function postTemplate(overwrite) {
        const body = {
            name: saveName.value.trim(),
            layout: { width: state.width, height: state.height, bbox_coord_space: "abs", bbox_format: "xyxy", summary: state.summary, items: state.items },
            overwrite,
        };
        if (saveCat.value === NEW_CAT) body.new_category = saveNewCat.value.trim();
        else body.category = saveCat.value;
        const res = await api.fetchApi("/moss_layout/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json().catch(() => ({})) };
    }

    saveOk.onclick = async () => {
        const name = saveName.value.trim();
        if (!name) { saveMsg.textContent = "Enter a template name."; return; }
        if (saveCat.value === NEW_CAT && !saveNewCat.value.trim()) { saveMsg.textContent = "Enter a category name."; return; }
        saveMsg.textContent = "Saving...";
        try {
            let r = await postTemplate(false);
            if (r.status === 409) {
                if (!confirm(`${r.data.error} Replace it?`)) { saveMsg.textContent = "Not saved."; return; }
                r = await postTemplate(true);
            }
            if (r.status !== 200) { saveMsg.textContent = `Could not save: ${r.data.error || r.status}`; return; }
            closeSaveForm();
            saveMsg.textContent = "";
            await loadTemplates(`${r.data.category}/${r.data.id}`);
            tplMsg.textContent = `Saved "${name}".`;
            window.dispatchEvent(new Event("moss-templates-changed"));
        } catch (e) {
            saveMsg.textContent = `Could not save: ${e.message}`;
        }
    };

    tplDelBtn.onclick = async () => {
        const t = templates[tplSel.value];
        if (!t?.user || !confirm(`Delete saved template "${t.name}"? This cannot be undone.`)) return;
        const res = await api.fetchApi(`/moss_layout/templates/${tplSel.value}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (res.status !== 200) { tplMsg.textContent = `Could not delete: ${data.error || res.status}`; return; }
        await loadTemplates();
        tplMsg.textContent = `Deleted "${t.name}".`;
        window.dispatchEvent(new Event("moss-templates-changed"));
    };

    // Accepts the editor draft (abs/xyxy) or the model prompt (abs_centralized/yxyx).
    function layoutToState(src) {
        if (!src || typeof src !== "object" || !Array.isArray(src.items)) throw new Error("Expected an object with an items array.");
        const centred = src.bbox_coord_space === "abs_centralized" && src.bbox_format === "yxyx";
        const width = parseInt(src.width) || 1024, height = parseInt(src.height) || 1024;
        if (!centred && !(src.bbox_coord_space === "abs" && src.bbox_format === "xyxy") && !src.width) {
            throw new Error("Expected an absolute xyxy draft or a centralized yxyx prompt.");
        }
        const items = src.items.map((it, i) => {
            if (!Array.isArray(it.bbox) || it.bbox.length !== 4) throw new Error(`items[${i}].bbox must contain four numbers.`);
            let bbox = it.bbox;
            if (centred) {
                const [top, left, bottom, right] = bbox;
                bbox = [left + Math.floor(width / 2), top + Math.floor(height / 2), right + Math.floor(width / 2), bottom + Math.floor(height / 2)];
            }
            const out = { label: it.label || "object", caption: it.caption || "", text: it.text || "", bbox };
            for (const k of ["tags", "palette"]) if (k in it) out[k] = it[k];
            return out;
        });
        const summary = { ...(src.summary || {}) };
        summary.caption = summary.caption || "";
        return { width, height, summary, items };
    }

    function applyState(next) {
        state.width = clamp(Math.round(next.width / 16) * 16, MIN_EDGE, 4096);
        state.height = clamp(Math.round(next.height / 16) * 16, MIN_EDGE, 4096);
        state.summary = next.summary;
        state.items = next.items.map((it) => ({ ...it, bbox: normBox(it.bbox) }));
        ui.sel = -1;
        commit(); syncAll();
    }

    tplBtn.onclick = () => {
        const t = templates[tplSel.value];
        if (!t) return;
        applyState(layoutToState(t.layout));
        tplMsg.textContent = "";
    };
    const refreshJson = () => { jsonArea.value = JSON.stringify({ width: state.width, height: state.height, bbox_coord_space: "abs", bbox_format: "xyxy", summary: state.summary, items: state.items }, null, 2); jsonMsg.textContent = ""; };
    jsonRefresh.onclick = refreshJson;
    jsonBox.addEventListener("toggle", () => { if (jsonBox.open) refreshJson(); });
    jsonLoad.onclick = () => {
        try { applyState(layoutToState(JSON.parse(jsonArea.value))); jsonMsg.textContent = "Layout loaded."; }
        catch (e) { jsonMsg.textContent = `Could not load: ${e.message}`; }
    };

    // Re-read state after ComfyUI restores saved widget values (workflow load).
    root._reload = () => {
        try {
            const parsed = JSON.parse(dataWidget.value);
            if (parsed && parsed.width) {
                state = { width: parsed.width, height: parsed.height, summary: parsed.summary || { caption: "" }, items: parsed.items || [] };
            }
        } catch (e) { return; }
        ui.sel = -1; undo = []; redo = []; lastSnap = snapshot();
        syncAll();
    };

    new ResizeObserver(() => render()).observe(stage);
    syncAll();
    dataWidget.value = snapshot();
    return root;
}

app.registerExtension({
    name: "MossLayout.Editor",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            const dataWidget = this.widgets.find((w) => w.name === "layout_json");
            dataWidget.hidden = true;
            dataWidget.computeSize = () => [0, -4];
            if (dataWidget.element) dataWidget.element.style.display = "none";
            const root = buildEditor(this, dataWidget);
            this._mossRoot = root;
            this.addDOMWidget("moss_editor", "moss_editor", root, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 700,
            });
            const idx = this.widgets.findIndex((w) => w.name === "moss_editor");
            this.widgets.unshift(...this.widgets.splice(idx, 1));
            this.setSize([860, 960]);
            return r;
        };
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._mossRoot?._dispose?.();
            return onRemoved?.apply(this, arguments);
        };
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this._mossRoot?._reload();
            return r;
        };
    },
});
