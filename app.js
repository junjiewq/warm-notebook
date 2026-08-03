/**
 * 暖色手账 — calendar + markdown journal
 * Notes keyed in localStorage by YYYY-MM-DD
 */
(function () {
  "use strict";

  const STORAGE_KEY = "warm-notebook:v1";
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const WEEKDAYS_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let viewYear, viewMonth; // month 0-11
  let activeDate = null;
  let easyMDE = null;
  let autosaveTimer = null;
  let dirty = false;

  /* —— Storage —— */
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveAll(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function getNote(dateKey) {
    const all = loadAll();
    return all[dateKey] || { title: "", body: "" };
  }

  function setNote(dateKey, note) {
    const all = loadAll();
    const title = (note.title || "").trim();
    const body = (note.body || "").trim();
    if (!title && !body) {
      delete all[dateKey];
    } else {
      all[dateKey] = {
        title,
        body,
        updatedAt: new Date().toISOString(),
      };
    }
    saveAll(all);
  }

  function hasNote(dateKey) {
    const n = loadAll()[dateKey];
    return !!(n && ((n.title && n.title.trim()) || (n.body && n.body.trim())));
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function toKey(y, m, d) {
    return `${y}-${pad(m + 1)}-${pad(d)}`;
  }

  function todayKey() {
    const t = new Date();
    return toKey(t.getFullYear(), t.getMonth(), t.getDate());
  }

  function parseKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return { y, m: m - 1, d };
  }

  function formatDisplay(key) {
    const { y, m, d } = parseKey(key);
    return `${y}年${m + 1}月${d}日`;
  }

  /* —— Toast —— */
  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => {
        el.hidden = true;
      }, 280);
    }, 2200);
  }

  /* —— Calendar —— */
  function initWeekdays() {
    const row = $("#weekdayRow");
    row.innerHTML = WEEKDAYS.map((w) => `<span>${w}</span>`).join("");
  }

  function renderCalendar(animate) {
    const label = $("#monthLabel");
    const grid = $("#dayGrid");
    const title = `${viewYear}年 ${viewMonth + 1}月`;

    const paint = () => {
      label.textContent = title;
      label.classList.remove("is-switching");

      const first = new Date(viewYear, viewMonth, 1);
      const startPad = first.getDay();
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const prevDays = new Date(viewYear, viewMonth, 0).getDate();
      const today = todayKey();

      const cells = [];
      for (let i = 0; i < startPad; i++) {
        const d = prevDays - startPad + 1 + i;
        cells.push(dayButton(viewYear, viewMonth - 1, d, true));
      }
      for (let d = 1; d <= daysInMonth; d++) {
        cells.push(dayButton(viewYear, viewMonth, d, false));
      }
      const rem = (7 - (cells.length % 7)) % 7;
      for (let i = 1; i <= rem; i++) {
        cells.push(dayButton(viewYear, viewMonth + 1, i, true));
      }

      grid.innerHTML = "";
      cells.forEach((btn) => {
        const key = btn.dataset.date;
        if (key === today) btn.classList.add("today");
        if (hasNote(key)) btn.classList.add("has-note");
        btn.addEventListener("click", () => openEditor(key));
        grid.appendChild(btn);
      });
    };

    if (animate) {
      label.classList.add("is-switching");
      setTimeout(paint, 180);
    } else {
      paint();
    }
  }

  function dayButton(y, m, d, other) {
    // normalize overflow months
    const dt = new Date(y, m, d);
    const key = toKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-cell" + (other ? " other-month" : "");
    btn.dataset.date = key;
    btn.setAttribute("aria-label", formatDisplay(key));
    btn.innerHTML = `<span>${dt.getDate()}</span><span class="note-dot" aria-hidden="true"></span>`;
    return btn;
  }

  function shiftMonth(delta) {
    viewMonth += delta;
    if (viewMonth < 0) {
      viewMonth = 11;
      viewYear--;
    } else if (viewMonth > 11) {
      viewMonth = 0;
      viewYear++;
    }
    renderCalendar(true);
  }

  /* —— Editor —— */
  function initEditor() {
    easyMDE = new EasyMDE({
      element: $("#noteBody"),
      spellChecker: false,
      status: false,
      autofocus: false,
      placeholder: "写点什么吧… 支持 Markdown",
      minHeight: "200px",
      toolbar: [
        "bold",
        "italic",
        "heading",
        "|",
        "quote",
        "unordered-list",
        "ordered-list",
        "|",
        "link",
        "code",
        "|",
        "preview",
        "side-by-side",
        "fullscreen",
        "|",
        "guide",
      ],
      renderingConfig: {
        singleLineBreaks: false,
      },
    });

    easyMDE.codemirror.on("change", () => {
      dirty = true;
      setStatus("未保存…");
      scheduleAutosave();
    });
  }

  function setStatus(text) {
    $("#saveStatus").textContent = text;
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (activeDate && dirty) persistCurrent(true);
    }, 1800);
  }

  function persistCurrent(silent) {
    if (!activeDate || !easyMDE) return;
    const title = $("#noteTitle").value;
    const body = easyMDE.value();
    setNote(activeDate, { title, body });
    dirty = false;
    setStatus("已自动保存 · " + timeHM());
    if (!silent) toast("已保存");
    renderCalendar(false);
  }

  function timeHM() {
    const n = new Date();
    return `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }

  function openEditor(dateKey) {
    activeDate = dateKey;
    const note = getNote(dateKey);
    const { y, m, d } = parseKey(dateKey);
    const wd = new Date(y, m, d).getDay();

    $("#sheetWeekday").textContent = WEEKDAYS_FULL[wd];
    $("#sheetDate").textContent = formatDisplay(dateKey);
    $("#noteTitle").value = note.title || "";
    easyMDE.value(note.body || "");
    dirty = false;
    setStatus(hasNote(dateKey) ? "已加载" : "新的一天");

    const overlay = $("#overlay");
    const sheet = $("#editorSheet");
    overlay.hidden = false;
    sheet.hidden = false;
    document.body.classList.add("sheet-open");
    requestAnimationFrame(() => {
      overlay.classList.add("open");
      sheet.classList.add("open");
    });

    setTimeout(() => {
      easyMDE.codemirror.refresh();
      $("#noteTitle").focus();
    }, 380);
  }

  function closeEditor() {
    if (dirty) persistCurrent(true);
    const overlay = $("#overlay");
    const sheet = $("#editorSheet");
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    document.body.classList.remove("sheet-open");
    setTimeout(() => {
      overlay.hidden = true;
      sheet.hidden = true;
      activeDate = null;
    }, 400);
  }

  /* —— Export helpers —— */
  function downloadBlob(blob, filename) {
    if (window.saveAs) {
      saveAs(blob, filename);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  function downloadText(text, filename, mime) {
    downloadBlob(new Blob([text], { type: mime || "text/plain;charset=utf-8" }), filename);
  }

  function mdToHtml(md) {
    if (window.marked) {
      return marked.parse(md || "");
    }
    return `<pre>${escapeHtml(md || "")}</pre>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fillExportCard(dateKey) {
    const note = getNote(dateKey);
    const card = $("#exportCard");
    card.innerHTML = `
      <p class="ec-brand">暖色手账</p>
      <h1 class="ec-date">${formatDisplay(dateKey)}</h1>
      ${note.title ? `<h2 class="ec-title">${escapeHtml(note.title)}</h2>` : ""}
      <div class="ec-body">${mdToHtml(note.body || "（空）")}</div>
    `;
    return card;
  }

  function noteToMarkdown(dateKey) {
    const note = getNote(dateKey);
    const lines = [`# ${formatDisplay(dateKey)}`];
    if (note.title) lines.push("", `## ${note.title}`);
    lines.push("", note.body || "", "");
    return lines.join("\n");
  }

  function allNotesMarkdown() {
    const all = loadAll();
    const keys = Object.keys(all).sort();
    if (!keys.length) return "# 暖色手账\n\n（暂无笔记）\n";
    return keys.map(noteToMarkdown).join("\n---\n\n");
  }

  async function exportPdf(dateKey) {
    const card = fillExportCard(dateKey);
    const opt = {
      margin: 10,
      filename: `暖色手账-${dateKey}.pdf`,
      image: { type: "jpeg", quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    };
    await html2pdf().set(opt).from(card).save();
    toast("PDF 已下载");
  }

  async function exportImage(dateKey) {
    const card = fillExportCard(dateKey);
    // Move on-screen briefly for accurate canvas (some browsers clip offscreen)
    const prev = { left: card.style.left, top: card.style.top, zIndex: card.style.zIndex };
    card.style.left = "0";
    card.style.top = "0";
    card.style.zIndex = "-1";
    card.style.opacity = "0";
    try {
      const canvas = await html2canvas(card, {
        scale: 2,
        backgroundColor: "#FFF8F2",
        useCORS: true,
      });
      canvas.toBlob((blob) => {
        if (blob) {
          downloadBlob(blob, `暖色手账-${dateKey}.png`);
          toast("图片已下载");
        }
      }, "image/png");
    } finally {
      card.style.left = prev.left || "-9999px";
      card.style.top = prev.top || "0";
      card.style.zIndex = prev.zIndex || "";
      card.style.opacity = "";
    }
  }

  function exportDocx(dateKey) {
    const card = fillExportCard(dateKey);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>暖色手账</title></head><body>${card.innerHTML}</body></html>`;
    if (!window.htmlDocx || !htmlDocx.asBlob) {
      toast("DOCX 库未加载，请检查网络");
      return;
    }
    const blob = htmlDocx.asBlob(html);
    downloadBlob(blob, `暖色手账-${dateKey}.docx`);
    toast("DOCX 已下载");
  }

  function exportJsonDay(dateKey) {
    const note = getNote(dateKey);
    const payload = { date: dateKey, ...note };
    downloadText(JSON.stringify(payload, null, 2), `暖色手账-${dateKey}.json`, "application/json");
    toast("JSON 已下载");
  }

  function exportJsonAll() {
    const all = loadAll();
    downloadText(
      JSON.stringify({ app: "暖色手账", exportedAt: new Date().toISOString(), notes: all }, null, 2),
      `暖色手账-全部.json`,
      "application/json"
    );
    toast("全部 JSON 已下载");
  }

  function exportMdDay(dateKey) {
    downloadText(noteToMarkdown(dateKey), `暖色手账-${dateKey}.md`, "text/markdown;charset=utf-8");
    toast("Markdown 已下载");
  }

  function exportMdAll() {
    downloadText(allNotesMarkdown(), `暖色手账-全部.md`, "text/markdown;charset=utf-8");
    toast("全部 Markdown 已下载");
  }

  function resolveDayForExport() {
    return activeDate || todayKey();
  }

  async function handleExport(type) {
    const day = resolveDayForExport();
    try {
      switch (type) {
        case "md":
          exportMdDay(day);
          break;
        case "json":
          exportJsonDay(day);
          break;
        case "pdf":
          await exportPdf(day);
          break;
        case "docx":
          exportDocx(day);
          break;
        case "image":
          await exportImage(day);
          break;
        case "all-json":
          // show small choice via sequential: export all json + offer md
          exportJsonAll();
          setTimeout(() => exportMdAll(), 400);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(err);
      toast("导出失败，请重试");
    }
  }

  /* —— Bindings —— */
  function bind() {
    $("#prevMonth").addEventListener("click", () => shiftMonth(-1));
    $("#nextMonth").addEventListener("click", () => shiftMonth(1));
    $("#goToday").addEventListener("click", () => {
      const t = new Date();
      viewYear = t.getFullYear();
      viewMonth = t.getMonth();
      renderCalendar(true);
    });

    $("#closeSheet").addEventListener("click", closeEditor);
    $("#overlay").addEventListener("click", closeEditor);
    $("#saveNote").addEventListener("click", () => persistCurrent(false));

    $("#noteTitle").addEventListener("input", () => {
      dirty = true;
      setStatus("未保存…");
      scheduleAutosave();
    });
    $("#noteTitle").addEventListener("blur", () => {
      if (dirty) persistCurrent(true);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && dirty && activeDate) persistCurrent(true);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#editorSheet").hidden) {
        e.preventDefault();
        closeEditor();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && activeDate) {
        e.preventDefault();
        persistCurrent(false);
      }
    });

    $$("[data-export]").forEach((btn) => {
      btn.addEventListener("click", () => handleExport(btn.dataset.export));
    });

    $$("[data-day-export]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (dirty) persistCurrent(true);
        const type = btn.dataset.dayExport;
        const day = activeDate || todayKey();
        try {
          if (type === "md") exportMdDay(day);
          else if (type === "pdf") await exportPdf(day);
          else if (type === "image") await exportImage(day);
          else if (type === "docx") exportDocx(day);
        } catch (err) {
          console.error(err);
          toast("导出失败");
        }
      });
    });
  }

  function boot() {
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    initWeekdays();
    initEditor();
    renderCalendar(false);
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
