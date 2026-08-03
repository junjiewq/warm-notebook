/**
 * 暖色手账 — 日历打卡 + 可自定义学习线（多主题）
 * localStorage: { version:2, topics:[], notes:{ date: {title,body,topicIds,updatedAt} } }
 */
(function () {
  "use strict";

  const STORAGE_KEY = "warm-notebook:v2";
  const LEGACY_KEY = "warm-notebook:v1";
  const SEED_TOPICS = ["PolarDB", "Java", "英语"];
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const WEEKDAYS_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const TEMPLATE_MD =
    "## 今日目标\n- \n\n## 学到了\n- \n\n## 疑问 & 明天\n- \n";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let viewYear, viewMonth;
  let activeDate = null;
  let activeTopicId = null;
  let selectedTopicIds = [];
  let viewMode = "calendar"; // calendar | topics | topic-detail
  let easyMDE = null;
  let autosaveTimer = null;
  let dirty = false;

  function uid() {
    return "t_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* —— Storage (v2 + migrate v1) —— */
  function emptyStore() {
    return {
      version: 2,
      topics: SEED_TOPICS.map((name) => ({
        id: uid(),
        name,
        createdAt: new Date().toISOString(),
      })),
      notes: {},
    };
  }

  function migrateLegacy(raw) {
    const store = emptyStore();
    if (!raw || typeof raw !== "object") return store;
    Object.keys(raw).forEach((k) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      const n = raw[k] || {};
      store.notes[k] = {
        title: (n.title || "").trim(),
        body: (n.body || "").trim(),
        topicIds: Array.isArray(n.topicIds) ? n.topicIds.slice() : [],
        updatedAt: n.updatedAt || new Date().toISOString(),
      };
    });
    return store;
  }

  function loadStore() {
    try {
      const v2 = localStorage.getItem(STORAGE_KEY);
      if (v2) {
        const data = JSON.parse(v2);
        if (data && data.version === 2 && data.notes) {
          if (!Array.isArray(data.topics)) data.topics = [];
          return data;
        }
      }
      const v1 = localStorage.getItem(LEGACY_KEY);
      if (v1) {
        const migrated = migrateLegacy(JSON.parse(v1));
        saveStore(migrated);
        return migrated;
      }
    } catch {
      /* fall through */
    }
    const fresh = emptyStore();
    saveStore(fresh);
    return fresh;
  }

  function saveStore(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function getTopics() {
    return loadStore().topics.slice();
  }

  function findTopic(id) {
    return getTopics().find((t) => t.id === id) || null;
  }

  function addTopic(name) {
    const n = (name || "").trim();
    if (!n) return null;
    const store = loadStore();
    if (store.topics.some((t) => t.name === n)) {
      toast("主题已存在");
      return store.topics.find((t) => t.name === n);
    }
    const topic = { id: uid(), name: n, createdAt: new Date().toISOString() };
    store.topics.push(topic);
    saveStore(store);
    return topic;
  }

  function renameTopic(id, name) {
    const n = (name || "").trim();
    if (!n) return false;
    const store = loadStore();
    const t = store.topics.find((x) => x.id === id);
    if (!t) return false;
    t.name = n;
    saveStore(store);
    return true;
  }

  function deleteTopic(id) {
    const store = loadStore();
    store.topics = store.topics.filter((t) => t.id !== id);
    Object.keys(store.notes).forEach((date) => {
      const note = store.notes[date];
      if (note && Array.isArray(note.topicIds)) {
        note.topicIds = note.topicIds.filter((x) => x !== id);
      }
    });
    saveStore(store);
  }

  function getNote(dateKey) {
    const n = loadStore().notes[dateKey];
    return n
      ? {
          title: n.title || "",
          body: n.body || "",
          topicIds: Array.isArray(n.topicIds) ? n.topicIds.slice() : [],
          updatedAt: n.updatedAt || null,
        }
      : { title: "", body: "", topicIds: [], updatedAt: null };
  }

  function setNote(dateKey, note) {
    const store = loadStore();
    const title = (note.title || "").trim();
    const body = (note.body || "").trim();
    const topicIds = Array.isArray(note.topicIds) ? note.topicIds.filter(Boolean) : [];
    if (!title && !body) {
      delete store.notes[dateKey];
    } else {
      store.notes[dateKey] = {
        title,
        body,
        topicIds,
        updatedAt: new Date().toISOString(),
      };
    }
    saveStore(store);
  }

  function hasNote(dateKey) {
    const n = loadStore().notes[dateKey];
    return !!(n && ((n.title && n.title.trim()) || (n.body && n.body.trim())));
  }

  function countNotesForTopic(topicId) {
    const notes = loadStore().notes;
    return Object.keys(notes).filter((d) => {
      const n = notes[d];
      return n && Array.isArray(n.topicIds) && n.topicIds.includes(topicId) && hasNote(d);
    }).length;
  }

  function getEntriesForTopic(topicId, ascending) {
    const notes = loadStore().notes;
    const keys = Object.keys(notes)
      .filter((d) => {
        const n = notes[d];
        return n && Array.isArray(n.topicIds) && n.topicIds.includes(topicId);
      })
      .sort();
    if (ascending === false) keys.reverse();
    return keys
      .map((date) => {
        const n = notes[date] || {};
        const title = (n.title || "").trim();
        const content = (n.body || "").trim();
        if (!title && !content) return null;
        return {
          date,
          title,
          content: content || "（空）",
          topicIds: n.topicIds || [],
          updatedAt: n.updatedAt || null,
        };
      })
      .filter(Boolean);
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

  /* —— View mode (mobile tabs; ≥1000px calendar + topics side-by-side) —— */
  function isWideDesktop() {
    return window.matchMedia("(min-width: 1000px)").matches;
  }

  function setMode(mode) {
    viewMode = mode;
    const cal = $("#panelCalendar");
    const topics = $("#panelTopics");
    const detail = $("#panelTopicDetail");
    const exportBar = $("#mainExportBar");
    const tabCal = $("#tabCalendar");
    const tabTop = $("#tabTopics");
    const desk = $("#deskGrid");

    const showSide = isWideDesktop() && mode !== "topic-detail";
    const showCal = mode === "calendar" || showSide;
    const showTopicList = mode === "topics" || showSide;
    const showDetail = mode === "topic-detail";

    cal.hidden = !showCal;
    topics.hidden = !showTopicList;
    detail.hidden = !showDetail;
    if (exportBar) exportBar.hidden = showDetail;

    if (desk) {
      desk.classList.toggle("desk-grid--split", showCal && showTopicList);
      desk.classList.toggle("desk-grid--detail", showDetail);
    }

    const topicsActive = mode === "topics" || mode === "topic-detail";
    tabCal.classList.toggle("is-active", mode === "calendar");
    tabTop.classList.toggle("is-active", topicsActive);
    tabCal.setAttribute("aria-selected", mode === "calendar" ? "true" : "false");
    tabTop.setAttribute("aria-selected", topicsActive ? "true" : "false");

    if (showCal) renderCalendar(false);
    if (showTopicList) renderTopicList();
    if (showDetail) renderTopicDetail();
  }

  /* —— Calendar —— */
  function initWeekdays() {
    $("#weekdayRow").innerHTML = WEEKDAYS.map((w) => `<span>${w}</span>`).join("");
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

  /* —— Topics UI —— */
  function promptNewTopic() {
    const name = window.prompt("新建学习线主题名称（任意科目）", "");
    if (name === null) return null;
    const t = addTopic(name);
    if (t) {
      toast("已添加「" + t.name + "」");
      renderTopicList();
      renderTopicChips();
    }
    return t;
  }

  function promptRenameTopic(id) {
    const topic = findTopic(id);
    if (!topic) return;
    const name = window.prompt("修改主题名称", topic.name);
    if (name === null) return;
    const n = name.trim();
    if (!n) {
      toast("名称不能为空");
      return;
    }
    if (renameTopic(id, n)) {
      toast("已修改为「" + n + "」");
      renderTopicList();
      renderTopicChips();
      if (viewMode === "topic-detail" && activeTopicId === id) renderTopicDetail();
    }
  }

  function promptDeleteTopic(id) {
    const topic = findTopic(id);
    if (!topic) return;
    if (!window.confirm(`删除学习线「${topic.name}」？\n日记内容仍保留，只是去掉此标签。`)) return;
    deleteTopic(id);
    if (selectedTopicIds.includes(id)) {
      selectedTopicIds = selectedTopicIds.filter((x) => x !== id);
    }
    toast("已删除「" + topic.name + "」");
    renderTopicChips();
    if (activeTopicId === id) {
      activeTopicId = null;
      setMode("topics");
    } else {
      renderTopicList();
    }
  }

  function renderTopicList() {
    const list = $("#topicList");
    const empty = $("#topicsEmpty");
    const topics = getTopics();
    list.innerHTML = "";
    empty.hidden = topics.length > 0;
    topics.forEach((t) => {
      const count = countNotesForTopic(t.id);
      const li = document.createElement("li");
      li.className = "topic-item";
      li.innerHTML = `
        <button type="button" class="topic-item-main" data-topic-open="${escapeHtml(t.id)}">
          <span class="topic-item-name">${escapeHtml(t.name)}</span>
          <span class="topic-item-count">${count} 篇</span>
        </button>
        <div class="topic-item-ops">
          <button type="button" class="icon-mini" data-topic-rename="${escapeHtml(t.id)}" title="修改" aria-label="修改 ${escapeHtml(t.name)}">改</button>
          <button type="button" class="icon-mini danger" data-topic-delete="${escapeHtml(t.id)}" title="删除" aria-label="删除 ${escapeHtml(t.name)}">删</button>
        </div>`;
      li.querySelector("[data-topic-open]").addEventListener("click", () => {
        activeTopicId = t.id;
        setMode("topic-detail");
      });
      li.querySelector("[data-topic-rename]").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        promptRenameTopic(t.id);
      });
      li.querySelector("[data-topic-delete]").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        promptDeleteTopic(t.id);
      });
      list.appendChild(li);
    });
  }

  function renderTopicDetail() {
    const topic = findTopic(activeTopicId);
    if (!topic) {
      setMode("topics");
      return;
    }
    $("#topicDetailName").textContent = topic.name;
    const entries = getEntriesForTopic(activeTopicId, true);
    $("#topicDetailMeta").textContent = entries.length
      ? `共 ${entries.length} 篇 · 按时间排列`
      : "暂无挂到此主题的笔记";

    const ul = $("#topicNotes");
    const empty = $("#topicNotesEmpty");
    ul.innerHTML = "";
    empty.hidden = entries.length > 0;
    entries.forEach((e) => {
      const li = document.createElement("li");
      li.className = "topic-note-card";
      const preview = (e.content || "").replace(/\s+/g, " ").slice(0, 80);
      li.innerHTML = `
        <button type="button" class="topic-note-btn" data-date="${escapeHtml(e.date)}">
          <span class="topic-note-date">${escapeHtml(formatDisplay(e.date))}</span>
          <span class="topic-note-title">${escapeHtml(e.title || "（无标题）")}</span>
          <span class="topic-note-preview">${escapeHtml(preview)}${preview.length >= 80 ? "…" : ""}</span>
        </button>`;
      li.querySelector("button").addEventListener("click", () => openEditor(e.date));
      ul.appendChild(li);
    });
  }

  function toggleTopicSelection(topicId) {
    if (!topicId) return;
    if (selectedTopicIds.includes(topicId)) {
      selectedTopicIds = selectedTopicIds.filter((x) => x !== topicId);
    } else {
      selectedTopicIds = selectedTopicIds.concat(topicId);
    }
    dirty = true;
    setStatus("未保存…");
    renderTopicChips();
    if (activeDate) persistCurrent(true);
    const t = findTopic(topicId);
    if (t && selectedTopicIds.includes(topicId)) toast("已挂上「" + t.name + "」");
  }

  function renderTopicChips() {
    const box = $("#topicChips");
    if (!box) return;
    const topics = getTopics();
    box.innerHTML = "";
    if (!topics.length) {
      box.innerHTML = '<p class="chips-empty">还没有主题，点「新主题」添加</p>';
      return;
    }
    topics.forEach((t) => {
      const on = selectedTopicIds.includes(t.id);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "topic-chip" + (on ? " is-on" : "");
      btn.dataset.topicId = t.id;
      btn.textContent = t.name;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      box.appendChild(btn);
    });
  }

  function bindTopicChipsOnce() {
    const box = $("#topicChips");
    if (!box || box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    // 事件委托：避免手机端重建 DOM 时点选“没反应”
    box.addEventListener(
      "pointerup",
      (e) => {
        const btn = e.target.closest(".topic-chip");
        if (!btn || !box.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        toggleTopicSelection(btn.dataset.topicId);
      },
      { passive: false }
    );
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
      renderingConfig: { singleLineBreaks: false },
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
    setNote(activeDate, {
      title: $("#noteTitle").value,
      body: easyMDE.value(),
      topicIds: selectedTopicIds.slice(),
    });
    dirty = false;
    setStatus("已自动保存 · " + timeHM());
    if (!silent) toast("已保存");
    renderCalendar(false);
    if (viewMode === "topics") renderTopicList();
    if (viewMode === "topic-detail") renderTopicDetail();
  }

  function timeHM() {
    const n = new Date();
    return `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }

  function openEditor(dateKey) {
    activeDate = dateKey;
    const note = getNote(dateKey);
    selectedTopicIds = note.topicIds.slice();
    const { y, m, d } = parseKey(dateKey);
    const wd = new Date(y, m, d).getDay();

    $("#sheetWeekday").textContent = WEEKDAYS_FULL[wd];
    $("#sheetDate").textContent = formatDisplay(dateKey);
    $("#noteTitle").value = note.title || "";
    easyMDE.value(note.body || "");
    dirty = false;
    setStatus(hasNote(dateKey) ? "已加载" : "新的一天");
    renderTopicChips();

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
      selectedTopicIds = [];
      if (viewMode === "topic-detail") renderTopicDetail();
      if (viewMode === "topics") renderTopicList();
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
    if (window.marked) return marked.parse(md || "", { breaks: true });
    if (easyMDE && typeof easyMDE.markdown === "function") return easyMDE.markdown(md || "");
    return `<pre>${escapeHtml(md || "")}</pre>`;
  }

  function getSortedNotes(ascending) {
    const notes = loadStore().notes;
    const keys = Object.keys(notes).sort();
    if (ascending === false) keys.reverse();
    return keys
      .map((date) => {
        const n = notes[date] || {};
        const title = (n.title || "").trim();
        const content = (n.body || "").trim();
        if (!title && !content) return null;
        return {
          date,
          title,
          content: content || "（空）",
          topicIds: n.topicIds || [],
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
      topicIds: note.topicIds || [],
      updatedAt: note.updatedAt || null,
    };
  }

  function flushEditorIfNeeded() {
    if (dirty && activeDate) persistCurrent(true);
  }

  function alertNoNotes() {
    window.alert("暂无笔记");
  }

  function topicNamesForEntry(entry) {
    const map = Object.fromEntries(getTopics().map((t) => [t.id, t.name]));
    return (entry.topicIds || []).map((id) => map[id]).filter(Boolean);
  }

  function noteBlockMarkdown(entry) {
    const lines = [`## ${entry.date}`];
    if (entry.title) lines.push("", `### ${entry.title}`);
    const tags = topicNamesForEntry(entry);
    if (tags.length) lines.push("", `> 学习线：${tags.join(" · ")}`);
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
    const tags = topicNamesForEntry(entry);
    const tagHtml = tags.length
      ? `<p class="ec-tags">${tags.map((t) => escapeHtml(t)).join(" · ")}</p>`
      : "";
    const body =
      entry.content && entry.content !== "（空）"
        ? mdToHtml(entry.content)
        : `<p class="ec-empty">（空）</p>`;
    return `
      <article class="ec-block">
        <h1 class="ec-date">${heading}</h1>
        ${tagHtml}
        <div class="ec-body">${body}</div>
      </article>
    `;
  }

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
    const rect = card.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) throw new Error("export panel has zero size");
  }

  function teardownCapture(card) {
    card.classList.remove("is-capturing");
    card.setAttribute("aria-hidden", "true");
    card.style.cssText = "";
    card.innerHTML = "";
  }

  async function exportPdfFromEntries(entries, filename, label) {
    const card = fillExportPanel(entries, label || (entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : ""));
    try {
      await prepareCapture(card);
      await html2pdf()
        .set({
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
        })
        .from(card)
        .save();
      toast("PDF 已下载");
    } finally {
      teardownCapture(card);
    }
  }

  async function exportImageFromEntries(entries, filename, label) {
    const card = fillExportPanel(entries, label || (entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : ""));
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

  function exportDocxFromEntries(entries, filename, label) {
    const card = fillExportPanel(entries, label || (entries.length > 1 ? `共 ${entries.length} 篇 · 按日期` : ""));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>暖色手账</title>
<style>
body{font-family:Georgia,serif;color:#3D2A1F;line-height:1.7}
h1{font-size:20pt;margin:1.2em 0 0.4em}
h2{font-size:14pt;margin:0.4em 0}
.ec-brand{color:#C45C42;letter-spacing:0.08em}
.ec-sep{border:none;border-top:1px solid #E8A87C;margin:1.5em 0}
.ec-tags{color:#8B5E4B;font-size:11pt}
</style></head><body>${card.innerHTML}</body></html>`;
    card.innerHTML = "";
    if (!window.htmlDocx || !htmlDocx.asBlob) {
      toast("DOCX 库未加载，请检查网络");
      return;
    }
    downloadBlob(htmlDocx.asBlob(html), filename);
    toast("DOCX 已下载");
  }

  function exportJsonFromEntries(entries, filename, extra) {
    const payload = Object.assign(
      {
        app: "暖色手账",
        exportedAt: new Date().toISOString(),
        notes: entries.map(({ date, title, content, topicIds }) => ({
          date,
          title,
          content,
          topics: topicNamesForEntry({ topicIds }),
          topicIds: topicIds || [],
        })),
      },
      extra || {}
    );
    downloadText(JSON.stringify(payload, null, 2), filename, "application/json");
    toast("JSON 已下载");
  }

  function exportMdFromEntries(entries, filename, heading) {
    downloadText(notesToMarkdown(entries, heading), filename, "text/markdown;charset=utf-8");
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
    const entries = getSortedNotes(false);
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
        await exportPdfFromEntries(entries, "暖色手账-全部.pdf", "全部 · 按日期");
        break;
      case "docx":
        exportDocxFromEntries(entries, "暖色手账-全部.docx", "全部 · 按日期");
        break;
      case "image":
      case "png":
      case "图":
        await exportImageFromEntries(entries, "暖色手账-全部.png", "全部 · 按日期");
        break;
      default:
        exportJsonFromEntries(entries, "暖色手账-全部.json");
        setTimeout(() => {
          exportMdFromEntries(entries, "暖色手账-全部.md", "暖色手账 · 全部（按日期）");
        }, 350);
        break;
    }
  }

  async function exportTopic(topicId, type) {
    flushEditorIfNeeded();
    const topic = findTopic(topicId);
    if (!topic) {
      toast("主题不存在");
      return;
    }
    const entries = getEntriesForTopic(topicId, true);
    if (!entries.length) {
      alertNoNotes();
      return;
    }
    const safe = topic.name.replace(/[\\/:*?"<>|]/g, "_");
    const label = `学习线 · ${topic.name} · 共 ${entries.length} 篇`;
    switch (type) {
      case "md":
        exportMdFromEntries(entries, `暖色手账-${safe}.md`, label);
        break;
      case "json":
        exportJsonFromEntries(entries, `暖色手账-${safe}.json`, { topic: topic.name });
        break;
      case "pdf":
        await exportPdfFromEntries(entries, `暖色手账-${safe}.pdf`, label);
        break;
      case "docx":
        exportDocxFromEntries(entries, `暖色手账-${safe}.docx`, label);
        break;
      case "image":
        await exportImageFromEntries(entries, `暖色手账-${safe}.png`, label);
        break;
      default:
        break;
    }
  }

  async function exportByTopicPrompt() {
    const topics = getTopics();
    if (!topics.length) {
      window.alert("还没有主题。请先到「学习线」新建主题。");
      return;
    }
    const list = topics.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
    const pick = window.prompt(`按主题导出（把该主题下所有日期内容合在一起）\n输入序号或主题名：\n${list}`, "1");
    if (pick === null) return;
    const trimmed = pick.trim();
    let topic =
      topics.find((t) => t.name === trimmed) ||
      topics[Number(trimmed) - 1] ||
      null;
    if (!topic) {
      toast("未找到主题");
      return;
    }
    const fmt = window.prompt("导出格式：md / json / pdf / docx / image", "md");
    if (fmt === null) return;
    await exportTopic(topic.id, (fmt || "md").toLowerCase().trim());
  }

  async function handleExport(type) {
    try {
      if (type === "by-topic") {
        await exportByTopicPrompt();
        return;
      }
      if (type === "all" || type === "all-json") {
        const choice = window.prompt(
          "导出全部笔记（按日期分组）。\n输入格式：md / json / pdf / docx / image\n留空则同时导出 JSON + MD",
          ""
        );
        if (choice === null) return;
        await exportAll(choice);
        return;
      }
      await exportDay(type, resolveDayForExport());
    } catch (err) {
      console.error(err);
      toast("导出失败，请重试");
    }
  }

  /* —— Bindings —— */
  function bind() {
    bindTopicChipsOnce();
    $("#prevMonth").addEventListener("click", () => shiftMonth(-1));
    $("#nextMonth").addEventListener("click", () => shiftMonth(1));
    $("#goToday").addEventListener("click", () => {
      const t = new Date();
      viewYear = t.getFullYear();
      viewMonth = t.getMonth();
      renderCalendar(true);
    });

    $("#tabCalendar").addEventListener("click", () => setMode("calendar"));
    $("#tabTopics").addEventListener("click", () => setMode("topics"));
    $("#addTopicBtn").addEventListener("click", () => promptNewTopic());
    $("#sheetAddTopic").addEventListener("click", () => {
      const t = promptNewTopic();
      if (t && !selectedTopicIds.includes(t.id)) {
        selectedTopicIds.push(t.id);
        dirty = true;
        setStatus("未保存…");
        renderTopicChips();
      }
    });
    $("#backToTopics").addEventListener("click", () => setMode("topics"));
    $("#renameTopicBtn").addEventListener("click", () => {
      const topic = findTopic(activeTopicId);
      if (!topic) return;
      const name = window.prompt("重命名主题", topic.name);
      if (name === null) return;
      if (renameTopic(activeTopicId, name)) {
        toast("已重命名");
        renderTopicDetail();
        renderTopicChips();
      }
    });
    $("#deleteTopicBtn").addEventListener("click", () => {
      const topic = findTopic(activeTopicId);
      if (!topic) return;
      if (!window.confirm(`删除学习线「${topic.name}」？\n日记内容仍保留，只是去掉此标签。`)) return;
      deleteTopic(activeTopicId);
      activeTopicId = null;
      toast("已删除主题");
      setMode("topics");
      renderTopicChips();
    });

    $("#insertTemplate").addEventListener("click", () => {
      if (!easyMDE) return;
      const cur = easyMDE.value();
      easyMDE.value(cur ? cur + "\n\n" + TEMPLATE_MD : TEMPLATE_MD);
      dirty = true;
      setStatus("未保存…");
      toast("已插入模板");
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
        try {
          await exportDay(btn.dataset.dayExport, activeDate || todayKey());
        } catch (err) {
          console.error(err);
          toast("导出失败");
        }
      });
    });

    $$("[data-topic-export]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!activeTopicId) return;
        try {
          await exportTopic(activeTopicId, btn.dataset.topicExport);
        } catch (err) {
          console.error(err);
          toast("导出失败");
        }
      });
    });

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => setMode(viewMode), 120);
    });
  }

  function boot() {
    loadStore(); // migrate / seed
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    initWeekdays();
    initEditor();
    setMode("calendar");
    bind();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
