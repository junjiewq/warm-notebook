/**
 * 暖色手账 — 日历打卡 + 可自定义学习线（多主题）
 * localStorage: { version:2, topics:[], notes:{ date: {title,body,topicIds,updatedAt} } }
 * body 存 HTML（旧 Markdown 在加载时一次性转换）
 */
(function () {
  "use strict";

  const STORAGE_KEY = "warm-notebook:v2";
  const LEGACY_KEY = "warm-notebook:v1";
  const SEED_TOPICS = ["PolarDB", "Java", "英语"];
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const WEEKDAYS_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const TEMPLATE_HTML =
    "<h2>今日目标</h2><ul><li></li></ul><h2>学到了</h2><ul><li></li></ul><h2>疑问 &amp; 明天</h2><ul><li></li></ul>";
  const TINYMCE_BASE = "https://cdn.jsdelivr.net/npm/tinymce@7.6.1";
  const IMG_MAX_WIDTH = 1200;
  const IMG_JPEG_QUALITY = 0.82;
  const IMG_WARN_BYTES = 1.2 * 1024 * 1024;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  let viewYear, viewMonth;
  let activeDate = null;
  let activeTopicId = null;
  let selectedTopicIds = [];
  let viewMode = "calendar"; // calendar | topics | topic-detail
  let editor = null;
  let editorReady = null;
  let autosaveTimer = null;
  let dirty = false;
  let turndownSvc = null;

  /* Format painter state */
  let fpFormats = null;
  let fpSticky = false;
  let fpArmed = false;
  let fpApplying = false;

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

  function looksLikeHtml(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    if (t.charAt(0) !== "<") return false;
    return /<\/?[a-z][\s\S]*>/i.test(t);
  }

  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return (d.textContent || d.innerText || "").trim();
  }

  function mdToHtml(md) {
    if (window.marked) return marked.parse(md || "", { breaks: true });
    return `<p>${escapeHtml(md || "").replace(/\n/g, "<br>")}</p>`;
  }

  function bodyToHtml(body) {
    if (!body) return "";
    if (looksLikeHtml(body)) return body;
    return mdToHtml(body);
  }

  function htmlToMarkdown(html) {
    if (!html || html === "（空）") return "";
    if (!looksLikeHtml(html)) return html;
    try {
      if (!turndownSvc && window.TurndownService) {
        turndownSvc = new TurndownService({
          headingStyle: "atx",
          codeBlockStyle: "fenced",
          bulletListMarker: "-",
        });
      }
      if (turndownSvc) return turndownSvc.turndown(html);
    } catch (err) {
      console.warn(err);
    }
    return "```html\n" + html + "\n```";
  }

  function contentToHtml(content) {
    if (!content || content === "（空）") return `<p class="ec-empty">（空）</p>`;
    if (looksLikeHtml(content)) return content;
    return mdToHtml(content);
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

  function migrateBodiesToHtml(store) {
    let changed = false;
    Object.keys(store.notes || {}).forEach((date) => {
      const n = store.notes[date];
      if (!n || !n.body) return;
      if (looksLikeHtml(n.body)) return;
      n.body = mdToHtml(n.body);
      changed = true;
    });
    return changed;
  }

  function loadStore() {
    try {
      const v2 = localStorage.getItem(STORAGE_KEY);
      if (v2) {
        const data = JSON.parse(v2);
        if (data && data.version === 2 && data.notes) {
          if (!Array.isArray(data.topics)) data.topics = [];
          if (migrateBodiesToHtml(data)) saveStore(data);
          return data;
        }
      }
      const v1 = localStorage.getItem(LEGACY_KEY);
      if (v1) {
        const migrated = migrateLegacy(JSON.parse(v1));
        migrateBodiesToHtml(migrated);
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
      const preview = stripHtml(e.content || "").replace(/\s+/g, " ").slice(0, 80);
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

  /* —— Images (base64 for offline localStorage) —— */
  function compressImageBlob(blob, maxW, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxW) {
          h = Math.round((h * maxW) / w);
          w = maxW;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const keepPng = blob.type === "image/png" && blob.size < 400 * 1024 && w <= 800;
        const mime = keepPng ? "image/png" : "image/jpeg";
        const dataUrl = keepPng ? canvas.toDataURL(mime) : canvas.toDataURL(mime, quality);
        resolve(dataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image load failed"));
      };
      img.src = url;
    });
  }

  async function blobToDataUrl(blob) {
    if (!blob) throw new Error("empty blob");
    if (blob.size > IMG_WARN_BYTES) {
      toast("图片较大，正在压缩…");
    }
    try {
      return await compressImageBlob(blob, IMG_MAX_WIDTH, IMG_JPEG_QUALITY);
    } catch {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  }

  function collectClipboardImages(dataTransfer) {
    const out = [];
    const seen = new Set();
    const push = (file) => {
      if (!file || !file.size) return;
      // 允许空 type（部分浏览器截图如此）
      if (file.type && !/^image\//i.test(file.type)) return;
      const key = `${file.size}|${file.type}|${file.lastModified}|${file.name || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(file);
    };
    if (!dataTransfer) return out;
    try {
      if (dataTransfer.items && dataTransfer.items.length) {
        for (let i = 0; i < dataTransfer.items.length; i++) {
          const item = dataTransfer.items[i];
          if (!item) continue;
          if (item.kind === "file" && (!item.type || /^image\//i.test(item.type))) {
            push(item.getAsFile());
          }
        }
      }
      if (dataTransfer.files && dataTransfer.files.length) {
        for (let i = 0; i < dataTransfer.files.length; i++) {
          push(dataTransfer.files[i]);
        }
      }
    } catch (err) {
      console.warn("collectClipboardImages", err);
    }
    return out;
  }

  async function dataUrlsFromClipboardHtml(html) {
    const urls = [];
    if (!html || !/<img\b/i.test(html)) return urls;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const img of doc.querySelectorAll("img")) {
        const src = (img.getAttribute("src") || "").trim();
        if (src.startsWith("data:image/")) {
          urls.push(src);
          continue;
        }
        if (src.startsWith("blob:")) {
          try {
            const blob = await fetch(src).then((r) => r.blob());
            if (blob && blob.size > 0) urls.push(await blobToDataUrl(blob));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return urls;
  }

  async function insertImageDataUrl(ed, dataUrl, alt) {
    if (!ed || !dataUrl || !dataUrl.startsWith("data:image/")) return false;
    const safeAlt = escapeHtml(alt || "图片");
    ed.focus();
    ed.insertContent(
      `<p style="margin:0.6em 0;"><img src="${dataUrl}" alt="${safeAlt}" data-warm-img="1" style="max-width:100%;width:auto;height:auto;display:inline-block;border-radius:8px;vertical-align:middle;" /></p>`
    );
    dirty = true;
    setStatus("未保存…");
    scheduleAutosave();
    return true;
  }

  async function insertImageFromBlob(ed, blob, alt) {
    if (!ed || !blob) return false;
    try {
      const dataUrl = await blobToDataUrl(blob);
      return insertImageDataUrl(ed, dataUrl, alt);
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  function bindEditorImagePaste(ed) {
    if (ed._warmPasteBound) return;
    ed._warmPasteBound = true;
    let pasteLock = false;

    const onPaste = (e) => {
      if (pasteLock) return;
      const cd = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
      if (!cd) return;

      const files = collectClipboardImages(cd);
      let html = "";
      try {
        html = cd.getData("text/html") || "";
      } catch {
        /* ignore */
      }

      const likelyImagePaste =
        files.length > 0 || /<img[^>]+src=["'](?:blob:|data:image)/i.test(html);

      if (!likelyImagePaste) {
        // 纯网页复制：不拦截，交给 TinyMCE；预处理会清裂图
        return;
      }

      pasteLock = true;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

      (async () => {
        toast("正在粘贴图片…");
        let ok = 0;
        try {
          for (const file of files) {
            if (await insertImageFromBlob(ed, file, "粘贴图片")) ok += 1;
          }
          if (!ok) {
            const urls = await dataUrlsFromClipboardHtml(html);
            for (const u of urls) {
              if (await insertImageDataUrl(ed, u, "粘贴图片")) ok += 1;
            }
          }
          // 只清裂图占位，不动刚插入的 data: 图
          scrubEditorJunk(ed, { aggressive: false });
          toast(ok ? `已粘贴 ${ok} 张图片` : "未识别到图片，请用工具栏「图片」或拖拽文件");
        } catch (err) {
          console.error(err);
          toast("图片粘贴失败，请用工具栏「图片」");
        } finally {
          setTimeout(() => {
            pasteLock = false;
          }, 400);
        }
      })();
    };

    ed.on("PastePreProcess", (e) => {
      if (e && typeof e.content === "string") {
        // 网页粘贴：去掉无效 img / iframe，保留文字；data: 图保留
        e.content = sanitizePastedHtml(e.content);
      }
    });
    ed.on("PastePostProcess", (e) => {
      if (e && e.node && e.node.querySelectorAll) {
        e.node.querySelectorAll("iframe, object, embed").forEach((el) => el.remove());
        e.node.querySelectorAll("img").forEach((img) => {
          const src = img.getAttribute("src") || "";
          if (src.startsWith("data:image/")) {
            img.setAttribute("data-warm-img", "1");
            img.style.maxWidth = "100%";
            img.style.width = "auto";
            img.style.display = "inline-block";
            return;
          }
          // blob: 留给 images_upload_handler，不要立刻删
          if (src.startsWith("blob:")) return;
          if (isBrokenImageSrc(src) || !src) img.remove();
        });
      }
      setTimeout(() => scrubEditorJunk(ed, { aggressive: false }), 0);
    });
    ed.on("init", () => {
      bindBrokenImageGuard(ed);
      // 只在 iframe document 捕获粘贴（TinyMCE 编辑区在 iframe 内）
      try {
        const doc = ed.getDoc();
        if (doc && !doc._warmPasteBound) {
          doc._warmPasteBound = true;
          doc.addEventListener("paste", onPaste, true);
        }
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        scrubEditorJunk(ed, { aggressive: false });
        repairEditorImages(ed);
      }, 50);
    });
  }

  function isBrokenImageSrc(src) {
    const s = (src || "").trim();
    if (!s) return true;
    if (s.startsWith("data:image/")) return false;
    if (/^https?:\/\//i.test(s)) return false;
    if (s.startsWith("blob:")) return false; // handle separately
    // file: / relative / bare filenames like image.png
    if (/^file:/i.test(s)) return true;
    if (/^image\.(png|jpe?g|gif|webp)$/i.test(s)) return true;
    if (/^[^/]+\.(png|jpe?g|gif|webp|bmp)$/i.test(s)) return true;
    if (s.startsWith("./") || s.startsWith("../")) return true;
    return false;
  }

  function sanitizePastedHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
      // 文档站复制常带 iframe / 控件骨架，会造成空白大框
      doc
        .querySelectorAll(
          "iframe, object, embed, applet, script, style, link, meta, noscript, template, video, audio, canvas, svg, form, input, button, select, textarea"
        )
        .forEach((el) => el.remove());

      doc.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") || "";
        // 保留 data: / http(s): / blob:（blob 稍后由上传 handler 转 data）
        if (src.startsWith("data:image/") || src.startsWith("blob:") || /^https?:\/\//i.test(src)) {
          img.style.maxWidth = "100%";
          img.style.width = "auto";
          img.style.height = "auto";
          img.style.display = "inline-block";
          img.removeAttribute("width");
          img.removeAttribute("height");
          return;
        }
        if (isBrokenImageSrc(src) || !src) {
          img.remove();
          return;
        }
        img.style.maxWidth = "100%";
        img.style.width = "auto";
        img.style.height = "auto";
        img.style.display = "inline-block";
        img.removeAttribute("width");
        img.removeAttribute("height");
      });

      // 去掉空壳容器（常见于侧栏/双栏文档布局）
      doc.querySelectorAll("div, section, article, aside, main, header, footer, span").forEach((el) => {
        const text = (el.textContent || "").replace(/\u00a0/g, " ").trim();
        const hasMedia = el.querySelector("img, table, pre, code");
        if (!text && !hasMedia) el.remove();
      });

      return doc.body ? doc.body.innerHTML : html;
    } catch {
      return html;
    }
  }

  function scrubEditorJunk(ed, opts) {
    const aggressive = !!(opts && opts.aggressive);
    if (!ed || ed.removed) return 0;
    let body;
    try {
      body = ed.getBody();
    } catch {
      return 0;
    }
    if (!body) return 0;
    let n = 0;
    body
      .querySelectorAll(
        "iframe, object, embed, applet, script, style, video, audio, canvas, form, input, button, select, textarea"
      )
      .forEach((el) => {
        el.remove();
        n += 1;
      });
    body.querySelectorAll("img").forEach((img) => {
      const src = (img.getAttribute("src") || "").trim();
      const mce = (img.getAttribute("data-mce-src") || "").trim();
      if (
        isBrokenImageSrc(src) ||
        !src ||
        isBrokenImageSrc(mce) ||
        /^image\.(png|jpe?g|gif|webp)$/i.test((img.getAttribute("alt") || "").trim())
      ) {
        img.remove();
        n += 1;
      }
    });
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const dropTexts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const t = (node.nodeValue || "").trim();
      if (/^image\.(png|jpe?g|gif|webp)$/i.test(t)) dropTexts.push(node);
    }
    dropTexts.forEach((node) => {
      node.remove();
      n += 1;
    });
    // 千万不要在日常输入时删空 <p>/<br>，否则回车无法换行
    if (aggressive) {
      body.querySelectorAll("div, section, aside, span, figure, figcaption").forEach((el) => {
        if (el.closest("table")) return;
        const text = (el.textContent || "").replace(/\u00a0/g, " ").trim();
        const hasMedia = el.querySelector("img, table, pre, iframe, br");
        if ((!text || /^image\.(png|jpe?g|gif|webp)$/i.test(text)) && !hasMedia) {
          el.remove();
          n += 1;
        }
      });
    }
    if (n) {
      dirty = true;
      setStatus("未保存…");
      scheduleAutosave();
    }
    return n;
  }

  function bindBrokenImageGuard(ed) {
    if (!ed || ed._warmImgGuard) return;
    ed._warmImgGuard = true;
    // 不做 MutationObserver / 不做拦截 Enter（会破坏换行）
    ed.on("SetContent", () => {
      setTimeout(() => {
        scrubEditorJunk(ed, { aggressive: false });
        repairEditorImages(ed);
        unwrapZeroLineHeight(ed);
        ensureEditableTail(ed);
      }, 0);
    });
  }

  function unwrapZeroLineHeight(ed) {
    if (!ed || ed.removed) return;
    try {
      ed.getBody().querySelectorAll("[style*='line-height']").forEach((el) => {
        if (/line-height\s*:\s*0/i.test(el.getAttribute("style") || "")) {
          el.style.lineHeight = "";
        }
      });
    } catch {
      /* ignore */
    }
  }

  /** 正文末尾保证有一个空段落，方便在链接后继续打字换行 */
  function ensureEditableTail(ed) {
    if (!ed || ed.removed) return;
    let body;
    try {
      body = ed.getBody();
    } catch {
      return;
    }
    if (!body) return;
    const last = body.lastElementChild;
    if (!last) {
      body.innerHTML = "<p><br></p>";
      return;
    }
    const onlyLink =
      last.childNodes.length &&
      [...last.childNodes].every(
        (n) =>
          (n.nodeType === 1 && (n.tagName === "A" || n.tagName === "BR")) ||
          (n.nodeType === 3 && !(n.nodeValue || "").trim())
      ) &&
      last.querySelector("a[href]");
    const text = (last.textContent || "").replace(/\u00a0/g, " ").trim();
    if (onlyLink || (last.querySelector("a[href]") && text && !last.querySelector("a[href]").nextSibling)) {
      const p = ed.getDoc().createElement("p");
      p.innerHTML = "<br>";
      body.appendChild(p);
    }
  }


  async function repairEditorImages(ed) {
    if (!ed || ed.removed) return;
    let body;
    try {
      body = ed.getBody();
    } catch {
      return;
    }
    if (!body) return;
    const imgs = [...body.querySelectorAll("img")];
    let removed = 0;
    for (const img of imgs) {
      img.style.maxWidth = "100%";
      img.style.width = "auto";
      img.style.height = "auto";
      img.style.display = "inline-block";
      const src = (img.getAttribute("src") || "").trim();
      if (src.startsWith("data:image/")) continue;

      if (src.startsWith("blob:")) {
        try {
          const blob = await fetch(src).then((r) => r.blob());
          if (!blob || blob.size < 8) throw new Error("empty blob");
          const dataUrl = await blobToDataUrl(blob);
          img.setAttribute("src", dataUrl);
          img.removeAttribute("data-mce-src");
          img.setAttribute("data-warm-img", "1");
          dirty = true;
          continue;
        } catch {
          img.remove();
          removed += 1;
          dirty = true;
          continue;
        }
      }

      if (isBrokenImageSrc(src)) {
        img.remove();
        removed += 1;
        dirty = true;
        continue;
      }

      // http(s)：尝试转成 data URL 方便离线；失败则保留原链接
      if (/^https?:\/\//i.test(src) && img.getAttribute("data-warm-img") !== "1") {
        try {
          const blob = await fetch(src, { mode: "cors" }).then((r) => {
            if (!r.ok) throw new Error("fetch fail");
            return r.blob();
          });
          if (blob && /^image\//.test(blob.type || "image/png")) {
            const dataUrl = await blobToDataUrl(blob);
            img.setAttribute("src", dataUrl);
            img.setAttribute("data-warm-img", "1");
            dirty = true;
          }
        } catch {
          /* 外链保留，能显示就行 */
        }
      }
    }
    if (removed && activeDate) {
      setStatus("未保存…");
      scheduleAutosave();
    }
  }

  /* —— Format painter —— */
  function captureFormats(ed) {
    const formats = {
      bold: ed.queryCommandState("Bold"),
      italic: ed.queryCommandState("Italic"),
      underline: ed.queryCommandState("Underline"),
      strikethrough: ed.queryCommandState("Strikethrough"),
      forecolor: ed.queryCommandValue("ForeColor") || "",
      backcolor: ed.queryCommandValue("HiliteColor") || ed.queryCommandValue("BackColor") || "",
      fontsize: ed.queryCommandValue("FontSize") || "",
      fontname: ed.queryCommandValue("FontName") || "",
    };
    const node = ed.selection.getNode();
    if (node) {
      const block = ed.dom.getParent(node, "h1,h2,h3,h4,blockquote,pre,p,div,li");
      if (block) {
        const tag = block.nodeName.toLowerCase();
        if (/^h[1-4]$/.test(tag)) formats.block = tag;
        else if (tag === "blockquote") formats.block = "blockquote";
      }
    }
    return formats;
  }

  function applyFormats(ed, formats) {
    if (!formats || ed.selection.isCollapsed()) return;
    fpApplying = true;
    try {
      ed.undoManager.transact(() => {
        const syncToggle = (cmd, want) => {
          const on = !!ed.queryCommandState(cmd);
          if (want && !on) ed.execCommand(cmd);
          if (!want && on) ed.execCommand(cmd);
        };
        syncToggle("Bold", !!formats.bold);
        syncToggle("Italic", !!formats.italic);
        syncToggle("Underline", !!formats.underline);
        syncToggle("Strikethrough", !!formats.strikethrough);

        if (formats.forecolor) ed.execCommand("ForeColor", false, formats.forecolor);
        if (formats.backcolor) {
          try {
            ed.execCommand("HiliteColor", false, formats.backcolor);
          } catch {
            ed.execCommand("BackColor", false, formats.backcolor);
          }
        }
        if (formats.fontsize) ed.execCommand("FontSize", false, formats.fontsize);
        if (formats.fontname) ed.execCommand("FontName", false, formats.fontname);
        if (formats.block) ed.execCommand("FormatBlock", false, formats.block);
      });
    } finally {
      fpApplying = false;
    }
  }

  function setFormatPainterUi(ed, on) {
    try {
      const btn = ed.editorContainer && ed.editorContainer.querySelector('button[data-mce-name="formatpainter"]');
      if (btn) btn.classList.toggle("tox-tbtn--enabled", !!on);
    } catch {
      /* ignore */
    }
    document.body.classList.toggle("format-painter-on", !!on);
  }

  function armFormatPainter(ed, sticky) {
    if (ed.selection.isCollapsed()) {
      toast("请先选中带格式的文字");
      return;
    }
    fpFormats = captureFormats(ed);
    fpSticky = !!sticky;
    fpArmed = true;
    setFormatPainterUi(ed, true);
    toast(sticky ? "格式刷：连续模式（再点关闭）" : "格式刷：点选文字应用");
  }

  function disarmFormatPainter(ed) {
    fpArmed = false;
    fpSticky = false;
    fpFormats = null;
    if (ed) setFormatPainterUi(ed, false);
    document.body.classList.remove("format-painter-on");
  }

  function registerFormatPainter(ed) {
    ed.ui.registry.addIcon(
      "format-painter",
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 17.5V20h3.5L17 10.5l-3.5-3.5L4 17.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.5 7l3.5 3.5 1.8-1.8a1.5 1.5 0 000-2.1l-1.4-1.4a1.5 1.5 0 00-2.1 0L13.5 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    );

    ed.ui.registry.addToggleButton("formatpainter", {
      icon: "format-painter",
      tooltip: "格式刷（双击连续刷）",
      onAction: () => {
        if (fpArmed) {
          disarmFormatPainter(ed);
          toast("已取消格式刷");
          return;
        }
        armFormatPainter(ed, false);
      },
      onSetup: (api) => {
        const sync = () => api.setActive(fpArmed);
        sync();
        const timer = setInterval(sync, 200);
        const el = api.element || null;
        /* Double-click sticky via editor container */
        const host = ed.editorContainer;
        const onDbl = (e) => {
          const btn = e.target.closest('button[data-mce-name="formatpainter"]');
          if (!btn) return;
          e.preventDefault();
          e.stopPropagation();
          armFormatPainter(ed, true);
          api.setActive(true);
        };
        if (host) host.addEventListener("dblclick", onDbl);
        return () => {
          clearInterval(timer);
          if (host) host.removeEventListener("dblclick", onDbl);
        };
      },
    });

    ed.on("mouseup keyup", () => {
      if (!fpArmed || fpApplying || !fpFormats) return;
      if (ed.selection.isCollapsed()) return;
      applyFormats(ed, fpFormats);
      dirty = true;
      setStatus("未保存…");
      scheduleAutosave();
      if (!fpSticky) disarmFormatPainter(ed);
    });
  }

  /* —— Editor (TinyMCE) —— */
  function editorContentStyle() {
    return `
      body {
        font-family: "Source Serif 4", "Noto Sans SC", Georgia, serif;
        font-size: 17px;
        line-height: 1.75;
        color: #3D2A1F;
        background: #FFFAF5;
        margin: 12px 14px 20px;
        letter-spacing: 0.01em;
      }
      h1,h2,h3 { font-family: Fraunces, "Source Serif 4", serif; color: #3D2A1F; font-weight: 600; line-height: 1.3; }
      h1 { font-size: 1.45em; } h2 { font-size: 1.25em; } h3 { font-size: 1.1em; }
      a { color: #C45C42; text-decoration: underline; cursor: text; }
      a[href]:hover { color: #9a3f2c; }
      blockquote {
        margin: 0.6em 0; padding: 0.35em 0.9em;
        border-left: 3px solid #E8A87C; color: #6B4F3F;
        background: rgba(232,168,124,0.12); border-radius: 0 8px 8px 0;
      }
      table { border-collapse: collapse; width: 100%; }
      table td, table th { border: 1px solid #E8A87C; padding: 0.4em 0.55em; }
      table th { background: rgba(232,168,124,0.22); }
      img { max-width: 100%; width: auto; height: auto; display: inline-block; border-radius: 8px; vertical-align: middle; }
      img[data-mce-selected] { outline: 2px solid #4C8BF5; outline-offset: 2px; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
      pre { background: rgba(61,42,31,0.06); padding: 0.75em; border-radius: 8px; overflow: auto; }
      ul, ol { padding-left: 1.35em; }
      p { margin: 0.45em 0; }
    `;
  }

  function calcEditorHeight() {
    const sheet = $("#editorSheet");
    const meta = sheet && sheet.querySelector(".sheet-meta");
    const head = sheet && sheet.querySelector(".sheet-head");
    const foot = sheet && sheet.querySelector(".sheet-foot");
    const vh = window.innerHeight || 640;
    const used =
      (head ? head.offsetHeight : 56) +
      (foot ? foot.offsetHeight : 64) +
      (meta ? meta.offsetHeight : 120) +
      36;
    return Math.max(320, Math.min(vh - used, vh * 0.78));
  }

  function getEditorBody() {
    if (!editor) return "";
    return editor.getContent({ format: "html" }) || "";
  }

  function setEditorBody(html) {
    if (!editor) return;
    editor.setContent(html || "");
  }

  function destroyEditor() {
    if (editor) {
      try {
        editor.remove();
      } catch {
        /* ignore */
      }
      editor = null;
    }
    editorReady = null;
    disarmFormatPainter(null);
  }

  function initEditor() {
    if (!window.tinymce) {
      console.error("TinyMCE failed to load");
      toast("编辑器加载失败，请检查网络");
      return Promise.resolve(null);
    }
    if (editor) return Promise.resolve(editor);
    if (editorReady) return editorReady;

    editorReady = new Promise((resolve) => {
      tinymce.init({
        selector: "#noteBody",
        license_key: "gpl",
        base_url: TINYMCE_BASE,
        suffix: ".min",
        language: "zh_CN",
        language_url: "https://cdn.jsdelivr.net/npm/tinymce-i18n@25.1.1/langs7/zh_CN.js",
        promotion: false,
        branding: false,
        statusbar: false,
        menubar: false,
        resize: false,
        min_height: 240,
        height: calcEditorHeight(),
        forced_root_block: "p",
        newline_behavior: "block",
        br_in_pre: false,
        plugins: "lists link autolink image table code fullscreen searchreplace emoticons",
        toolbar:
          "undo redo | blocks | bold italic underline strikethrough | forecolor backcolor | formatpainter | bullist numlist | link unlink | image emoticons table | removeformat | searchreplace code fullscreen",
        toolbar_mode: "sliding",
        toolbar_sticky: true,
        contextmenu: "link unlink openlink image table",
        link_default_target: "_blank",
        link_default_protocol: "https",
        link_assume_external_targets: false,
        link_context_toolbar: true,
        link_title: false,
        rel_list: [{ title: "No Referrer", value: "noopener noreferrer" }],
        default_link_target: "_blank",
        paste_filter_drop: false,
        paste_webkit_styles: "color font-size font-weight background-color",
        paste_merge_formats: true,
        paste_remove_styles_if_webkit: false,
        automatic_uploads: true,
        images_reuse_filename: true,
        image_title: true,
        image_description: false,
        object_resizing: true,
        table_toolbar:
          "tableprops tabledelete | tableinsertrowbefore tableinsertrowafter tabledeleterow | tableinsertcolbefore tableinsertcolafter tabledeletecol",
        content_style: editorContentStyle(),
        content_css: false,
        skin: "oxide",
        skin_url: TINYMCE_BASE + "/skins/ui/oxide",
        content_css_cors: true,
        placeholder: "写点什么吧… 插图请用截图粘贴或工具栏「图片」；从网页复制只保留文字和链接",
        font_size_formats: "12px 14px 16px 18px 20px 24px 28px",
        block_formats: "段落=p; 标题 1=h1; 标题 2=h2; 标题 3=h3; 引用=blockquote",
        paste_data_images: true,
        mobile: {
          toolbar_mode: "sliding",
        },
        images_upload_handler: (blobInfo) =>
          blobToDataUrl(blobInfo.blob())
            .then((dataUrl) => dataUrl)
            .catch(() =>
              new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blobInfo.blob());
              })
            ),
        file_picker_types: "image",
        file_picker_callback: (callback, _value, meta) => {
          if (meta.filetype !== "image") return;
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            try {
              const dataUrl = await blobToDataUrl(file);
              callback(dataUrl, { title: file.name || "图片" });
            } catch {
              toast("图片插入失败");
            }
          };
          input.click();
        },
        setup: (ed) => {
          registerFormatPainter(ed);
          bindEditorImagePaste(ed);
          ed.on("init", () => {
            editor = ed;
            // 编辑时单击链接不跳转；Ctrl/Cmd+单击才打开
            try {
              const doc = ed.getDoc();
              if (doc) {
                doc.addEventListener(
                  "click",
                  (ev) => {
                    const a = ev.target && ev.target.closest && ev.target.closest("a[href]");
                    if (!a) return;
                    if (ev.metaKey || ev.ctrlKey) {
                      window.open(a.href, "_blank", "noopener,noreferrer");
                      ev.preventDefault();
                      ev.stopPropagation();
                      return;
                    }
                    // 单击：不跳转、不整段选中（否则回车会像“删掉/没换行”）
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                      if (typeof ed.selection.placeCaretAt === "function") {
                        ed.selection.placeCaretAt(ev.clientX, ev.clientY);
                      } else {
                        const rng = ed.dom.createRng();
                        rng.selectNodeContents(a);
                        rng.collapse(false); // 光标到链接末尾
                        ed.selection.setRng(rng);
                      }
                      ed.focus();
                    } catch {
                      /* ignore */
                    }
                  },
                  true
                );
              }
            } catch {
              /* ignore */
            }
            resolve(ed);
          });
          ed.on("ExecCommand", (e) => {
            // 纠正误加的 http://https://
            if (e.command === "mceInsertLink" || e.command === "createlink") {
              setTimeout(() => normalizeEditorLinks(ed), 0);
            }
          });
          ed.on("change SetContent", () => {
            setTimeout(() => normalizeEditorLinks(ed), 0);
          });
          ed.on("change input undo redo SetContent", () => {
            if (fpApplying) return;
            dirty = true;
            setStatus("未保存…");
            scheduleAutosave();
          });
          ed.on("drop", (e) => {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;
            const imgs = collectClipboardImages(e.dataTransfer);
            if (!imgs.length) return;
            e.preventDefault();
            toast("正在插入图片…");
            (async () => {
              let ok = 0;
              for (const file of imgs) {
                if (await insertImageFromBlob(ed, file, file.name || "拖入图片")) ok += 1;
              }
              toast(ok ? `已插入 ${ok} 张图片` : "图片插入失败");
            })();
          });
        },
      });
    });

    return editorReady;
  }

  function normalizeEditorLinks(ed) {
    if (!ed || ed.removed) return;
    let body;
    try {
      body = ed.getBody();
    } catch {
      return;
    }
    if (!body) return;
    body.querySelectorAll("a[href]").forEach((a) => {
      let href = (a.getAttribute("href") || "").trim();
      if (!href) return;
      // 修复 http://https://xxx
      href = href.replace(/^https?:\/\/(?=https?:\/\/)/i, "");
      // 纯域名补协议
      if (/^[\w.-]+\.[a-z]{2,}([\/?#].*)?$/i.test(href)) {
        href = "https://" + href;
      }
      if (href !== a.getAttribute("href")) {
        a.setAttribute("href", href);
        dirty = true;
      }
      if (!a.getAttribute("target")) a.setAttribute("target", "_blank");
      if (!a.getAttribute("rel")) a.setAttribute("rel", "noopener noreferrer");
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
    if (!activeDate || !editor) return;
    setNote(activeDate, {
      title: $("#noteTitle").value,
      body: getEditorBody(),
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

  function resizeEditorToSheet() {
    if (!editor) return;
    const h = calcEditorHeight();
    const container = editor.getContainer();
    if (container) {
      container.style.height = h + "px";
      container.style.maxHeight = h + "px";
    }
    try {
      if (editor.theme && typeof editor.theme.resizeTo === "function") {
        editor.theme.resizeTo(null, h);
      }
    } catch {
      /* ignore */
    }
    try {
      const header = container && container.querySelector(".tox-editor-header");
      const headerH = header ? header.offsetHeight : 48;
      if (editor.iframeElement) {
        editor.iframeElement.style.height = Math.max(160, h - headerH - 2) + "px";
      }
    } catch {
      /* ignore */
    }
  }

  async function openEditor(dateKey) {
    activeDate = dateKey;
    const note = getNote(dateKey);
    selectedTopicIds = note.topicIds.slice();
    const { y, m, d } = parseKey(dateKey);
    const wd = new Date(y, m, d).getDay();

    $("#sheetWeekday").textContent = WEEKDAYS_FULL[wd];
    $("#sheetDate").textContent = formatDisplay(dateKey);
    $("#noteTitle").value = note.title || "";
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

    try {
      await initEditor();
      if (!editor) return;
      setEditorBody(bodyToHtml(note.body || ""));
      dirty = false;
      setTimeout(() => {
        resizeEditorToSheet();
        unwrapZeroLineHeight(editor);
        ensureEditableTail(editor);
        try {
          editor.focus();
        } catch {
          /* ignore */
        }
      }, 380);
    } catch (err) {
      console.error(err);
      toast("编辑器打开失败");
    }
  }

  function closeEditor() {
    if (dirty) persistCurrent(true);
    if (editor) disarmFormatPainter(editor);
    const overlay = $("#overlay");
    const sheet = $("#editorSheet");
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    document.body.classList.remove("sheet-open");
    document.body.classList.remove("format-painter-on");
    setTimeout(() => {
      overlay.hidden = true;
      sheet.hidden = true;
      activeDate = null;
      selectedTopicIds = [];
      destroyEditor();
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
    const mdBody = htmlToMarkdown(entry.content || "");
    lines.push("", mdBody || "（空）", "");
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
    const body = contentToHtml(entry.content);
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
img{max-width:100%;height:auto}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #E8A87C;padding:4px 8px}
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
      if (!activeTopicId) return;
      promptRenameTopic(activeTopicId);
    });
    $("#deleteTopicBtn").addEventListener("click", () => {
      if (!activeTopicId) return;
      promptDeleteTopic(activeTopicId);
    });

    $("#insertTemplate").addEventListener("click", () => {
      if (!editor) return;
      const cur = getEditorBody().trim();
      setEditorBody(cur ? cur + TEMPLATE_HTML : TEMPLATE_HTML);
      dirty = true;
      setStatus("未保存…");
      scheduleAutosave();
      toast("已插入模板");
    });

    const scrubBtn = $("#scrubJunkBtn");
    if (scrubBtn) {
      scrubBtn.addEventListener("click", () => {
        if (!editor) return;
        const n = scrubEditorJunk(editor, { aggressive: true });
        repairEditorImages(editor);
        toast(n ? `已清理 ${n} 处无效内容` : "没有需要清理的内容");
      });
    }

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
        if (fpArmed && editor) {
          e.preventDefault();
          disarmFormatPainter(editor);
          toast("已取消格式刷");
          return;
        }
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
      resizeTimer = setTimeout(() => {
        setMode(viewMode);
        if (editor && activeDate && !$("#editorSheet").hidden) {
          resizeEditorToSheet();
        }
      }, 120);
    });
  }

  function boot() {
    loadStore(); // migrate / seed
    const t = new Date();
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    initWeekdays();
    setMode("calendar");
    bind();
    /* Lazy-init TinyMCE on first open for faster first paint */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
