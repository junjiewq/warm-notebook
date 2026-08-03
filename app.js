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
      return marked.parse(md || "", { breaks: true });
    }
    if (easyMDE && typeof easyMDE.markdown === "function") {
      return easyMDE.markdown(md || "");
    }
    return `<pre>${escapeHtml(md || "")}</pre>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Sorted note entries: [{ date, title, content, updatedAt? }] */
  function getSortedNotes(ascending) {
    const all = loadAll();
    const keys = Object.keys(all).sort();
    if (ascending === false) keys.reverse();
    return keys
      .map((date) => {
        const n = all[date] || {};
        const title = (n.title || "").trim();
        const content = (n.body || "").trim();
        if (!title && !content) return null;
        return {
          date,
          title,
          content: content || "（空）",
          updatedAt: n.updatedAt || null,
        };
      })
      .filter(Boolean);
  }

  function getDayEntry(dateKey) {
    flushEditorIfNeeded();
    const note = getNote(dateKey);
    const title = (note.title || "").trim();
    const content = (note.body || "").trim();
    if (!title && !content) return null;
    return {
      date: dateKey,
      title,
      content: content || "（空）",
      updatedAt: note.updatedAt || null,
    };
  }

  function flushEditorIfNeeded() {
    if (dirty && activeDate) persistCurrent(true);
  }

  function alertNoNotes() {
    window.alert("暂无笔记");
  }

  function noteBlockMarkdown(entry) {
    const lines = [`## ${entry.date}`];
    if (entry.title) lines.push("", `### ${entry.title}`);
    lines.push("", entry.content || "（空）", "");
    return lines.join("\n");
  }

  function notesToMarkdown(entries, heading) {
    const parts = [`# ${heading || "暖色手账"}`, ""];
    entries.forEach((entry, i) => {
      if (i > 0) parts.push("---", "");
      parts.push(noteBlockMarkdown(entry));
    });
    return parts.join("\n");
  }

  function noteBlockHtml(entry) {
    const heading = entry.title
      ? `${escapeHtml(entry.date)} ${escapeHtml(entry.title)}`
      : escapeHtml(entry.date);
    const body =
      entry.content && entry.content !== "（空）"
        ? mdToHtml(entry.content)
        : `<p class="ec-empty">（空）</p>`;
    return `
      <article class="ec-block">
        <h1 class="ec-date">${heading}</h1>
        <div class="ec-body">${body}</div>
      </article>
    `;
  }

  /**
   * Fill on-screen export panel with date-grouped note HTML.
   * Panel is visible (opacity ~1, fixed, sized) so html2canvas/html2pdf get non-zero pixels.
   */
  function fillExportPanel(entries, label) {
    const card = $("#exportCard");
    const blocks = entries.map(noteBlockHtml).join('<hr class="ec-sep" />');
    card.innerHTML = `
      <p class="ec-brand">暖色手账</p>
      ${label ? `<p class="ec-meta">${escapeHtml(label)}</p>` : ""}
      ${blocks}
    `;
    return card;
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let left = n;
      const tick = () => {
        left -= 1;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async function prepareCapture(card) {
    card.classList.add("is-capturing");
    card.setAttribute("aria-hidden", "false");
    // Force layout with real dimensions on-screen (not off-DOM / opacity:0)
    card.style.cssText =
      "position:fixed;left:0;top:0;width:640px;max-width:96vw;opacity:1;visibility:visible;pointer-events:none;z-index:2147483000;transform:none;";
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
    }
    await waitFrames(2);
    // Ensure non-zero box
    const rect = card.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      throw new Error("export panel has zero size");
    }
  }

  function teardownCapture(card) {
    card.classList.remove("is-capturing");
    card.setAttribute("aria-hidden", "true");
    card.style.cssText = "";
    card.innerHTML = "";
  }

  async function exportPdfFromEntries(entries, filename) {
    const card = fillExportPanel(entries, entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : "");
    try {
      await prepareCapture(card);
      const opt = {
        margin: [12, 12, 12, 12],
        filename,
        image: { type: "jpeg", quality: 0.96 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          backgroundColor: "#FFF8F2",
          logging: false,
          windowWidth: Math.max(card.scrollWidth, 640),
          windowHeight: Math.max(card.scrollHeight, 200),
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] },
      };
      await html2pdf().set(opt).from(card).save();
      toast("PDF 已下载");
    } finally {
      teardownCapture(card);
    }
  }

  async function exportImageFromEntries(entries, filename) {
    const card = fillExportPanel(entries, entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : "");
    try {
      await prepareCapture(card);
      const canvas = await html2canvas(card, {
        scale: 2,
        backgroundColor: "#FFF8F2",
        useCORS: true,
        allowTaint: true,
        logging: false,
        width: card.scrollWidth,
        height: card.scrollHeight,
        windowWidth: card.scrollWidth,
        windowHeight: card.scrollHeight,
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("image blob empty");
      downloadBlob(blob, filename);
      toast("图片已下载");
    } finally {
      teardownCapture(card);
    }
  }

  function exportDocxFromEntries(entries, filename) {
    const card = fillExportPanel(entries, entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : "");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>暖色手账</title>
<style>
body{font-family:Georgia,serif;color:#3D2A1F;line-height:1.7}
h1{font-size:20pt;margin:1.2em 0 0.4em}
h2{font-size:14pt;margin:0.4em 0}
.ec-brand{color:#C45C42;letter-spacing:0.08em}
.ec-sep{border:none;border-top:1px solid #E8A87C;margin:1.5em 0}
</style></head><body>${card.innerHTML}</body></html>`;
    card.innerHTML = "";
    if (!window.htmlDocx || !htmlDocx.asBlob) {
      toast("DOCX 库未加载，请检查网络");
      return;
    }
    const blob = htmlDocx.asBlob(html);
    downloadBlob(blob, filename);
    toast("DOCX 已下载");
  }

  function exportJsonFromEntries(entries, filename) {
    const payload = {
      app: "暖色手账",
      exportedAt: new Date().toISOString(),
      notes: entries.map(({ date, title, content }) => ({ date, title, content })),
    };
    downloadText(JSON.stringify(payload, null, 2), filename, "application/json");
    toast("JSON 已下载");
  }

  function exportMdFromEntries(entries, filename, heading) {
    downloadText(
      notesToMarkdown(entries, heading),
      filename,
      "text/markdown;charset=utf-8"
    );
    toast("Markdown 已下载");
  }

  function resolveDayForExport() {
    return activeDate || todayKey();
  }

  async function exportDay(type, dateKey) {
    flushEditorIfNeeded();
    const entry = getDayEntry(dateKey);
    if (!entry) {
      alertNoNotes();
      return;
    }
    const entries = [entry];
    switch (type) {
      case "md":
        exportMdFromEntries(entries, `暖色手账-${dateKey}.md`, `暖色手账 · ${dateKey}`);
        break;
      case "json":
        exportJsonFromEntries(entries, `暖色手账-${dateKey}.json`);
        break;
      case "pdf":
        await exportPdfFromEntries(entries, `暖色手账-${dateKey}.pdf`);
        break;
      case "docx":
        exportDocxFromEntries(entries, `暖色手账-${dateKey}.docx`);
        break;
      case "image":
        await exportImageFromEntries(entries, `暖色手账-${dateKey}.png`);
        break;
      default:
        break;
    }
  }

  async function exportAll(type) {
    flushEditorIfNeeded();
    const entries = getSortedNotes(false); // newest first
    if (!entries.length) {
      alertNoNotes();
      return;
    }
    const fmt = (type || "").toLowerCase().trim();
    switch (fmt) {
      case "md":
        exportMdFromEntries(entries, "暖色手账-全部.md", "暖色手账 · 全部（按日期）");
        break;
      case "json":
        exportJsonFromEntries(entries, "暖色手账-全部.json");
        break;
      case "pdf":
        await exportPdfFromEntries(entries, "暖色手账-全部.pdf");
        break;
      case "docx":
        exportDocxFromEntries(entries, "暖色手账-全部.docx");
        break;
      case "image":
      case "png":
      case "图":
        await exportImageFromEntries(entries, "暖色手账-全部.png");
        break;
      default:
        // 「全部」默认：JSON 数组 + MD，均按日期成块
        exportJsonFromEntries(entries, "暖色手账-全部.json");
        setTimeout(() => {
          exportMdFromEntries(entries, "暖色手账-全部.md", "暖色手账 · 全部（按日期）");
        }, 350);
        break;
    }
  }

  async function handleExport(type) {
    try {
      if (type === "all" || type === "all-json") {
        const choice = window.prompt(
          "导出全部笔记（按日期分组）。\n输入格式：md / json / pdf / docx / image\n留空则同时导出 JSON + MD",
          ""
        );
        if (choice === null) return; // cancelled
        await exportAll(choice);
        return;
      }
      // Top-bar format buttons: current day (active / today)
      await exportDay(type, resolveDayForExport());
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
        const type = btn.dataset.dayExport;
        const day = activeDate || todayKey();
        try {
          await exportDay(type, day);
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
