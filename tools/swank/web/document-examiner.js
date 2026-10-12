"use strict";

const examiner = (() => {
  function newViewer(name) {
    return {name, sections: [], bookmarks: [], candidates: [], candidateIndex: -1, current: null, scroll: 0};
  }
  state.examiner ??= {current: "Default Viewer", previous: null, viewers: [newViewer("Default Viewer")]};
  const saved = state.examiner;
  const sections = new Map();
  let renderedViewer = null;
  let loading = false;
  let scrollTimer;
  let typeout = false;
  const editor = $("examiner-command");
  function commandPrompt() {
    const prompt = node("span", "▶", "command-prompt");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "7"); svg.setAttribute("height", "7");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", "M0 0H1V1H3V2H5V3H7V4H5V5H3V6H1V7H0Z");
    svg.append(path); prompt.append(svg);
    return prompt;
  }
  $("examiner-command-form").querySelector("label").replaceChildren(commandPrompt());

  function viewer() {
    const result = saved.viewers.find(item => item.name === saved.current);
    if (!result) throw new Error("The selected document viewer no longer exists.");
    return result;
  }
  function persist() { save(); }
  function topicSummary(topic) {
    if (!topic || typeof topic.id !== "string" || typeof topic.title !== "string") {
      throw new Error("Invalid documentation topic returned by the guest.");
    }
    return topic;
  }
  function closeMenu() { $("examiner-menu").close(); }
  function menu(title, items) {
    const panel = $("examiner-menu-items");
    $("examiner-menu-title").textContent = title;
    panel.replaceChildren();
    for (const [name, action, help] of items) {
      panel.append(button(name, async () => { closeMenu(); await action(); }, help));
    }
    panel.append(button("Close", async () => { closeMenu(); editor.focus(); }));
    if (!$("examiner-menu").open) $("examiner-menu").showModal();
    placeDialogOnPixels($("examiner-menu"));
  }
  function topicButton(topic, role = "topic", text = topic.title) {
    topicSummary(topic);
    const result = button(text, () => readTopic(topic.id),
      role === "bookmark"
        ? "Mouse-L: Read. Mouse-M: Overview. Mouse-R: Menu. Shift-M: Discard topic."
        : "Mouse-L: Read. Mouse-M: Overview. Mouse-R: Menu. Shift-M: Insert bookmark.");
    result.className = "document-topic";
    result.dataset.topic = topic.id;
    result.title = [topic.title, topic.book, topic.type].filter(Boolean).join(" — ");
    result.onauxclick = event => {
      if (event.button !== 1) return;
      event.preventDefault();
      run(async () => {
        if (event.shiftKey) {
          if (role === "bookmark") discard(topic.id);
          else deferTopic(topic);
        } else await overview(topic.id);
      });
    };
    result.onmousedown = event => { if (event.button === 1) event.preventDefault(); };
    result.oncontextmenu = event => {
      event.preventDefault(); event.stopPropagation();
      menu(topic.title, [
        ["View the documentation", () => readTopic(topic.id)],
        ["Hardcopy documentation", () => hardcopyTopic(topic.id)],
        ["Display a table of contents", () => candidates("contents", {topic: topic.id})],
        ["Insert a bookmark", async () => deferTopic(topic)],
        ["Display an overview", () => overview(topic.id)],
        ...(viewer().bookmarks.some(item => item.topic.id === topic.id)
          ? [["Discard a topic", async () => discard(topic.id)]] : [])
      ]);
    };
    return result;
  }
  function inline(parent, content) {
    for (const item of content || []) {
      let element;
      switch (item.kind) {
        case ":text": element = document.createTextNode(item.text); break;
        case ":code": element = node("code", item.text); break;
        case ":emphasis": element = node("em", item.text); break;
        case ":strong": element = node("strong", item.text); break;
        case ":link":
          if (item.topic) element = topicButton({id: item.topic, title: item.title || item.text, book: item.book}, "topic", item.text);
          else {
            const url = new URL(item.url, location.href);
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported documentation link protocol.");
            element = node("a", item.text);
            element.href = url.href;
            element.target = "_blank";
            element.rel = "noopener noreferrer";
            element.dataset.help = "Mouse-L: Open the source link in another browser tab.";
          }
          break;
        default: throw new Error("Unsupported documentation inline kind: " + item.kind);
      }
      parent.append(element);
    }
  }
  function blocks(parent, records) {
    for (const block of records || []) {
      let element;
      switch (block.kind) {
        case ":paragraph": element = node("p"); inline(element, block.content); break;
        case ":code": element = node("pre", block.text); break;
        case ":list":
          element = node(block.ordered ? "ol" : "ul");
          for (const [index, item] of (block.items || []).entries()) {
            const li = node("li");
            li.style.marginLeft = Math.max(0, block.depths?.[index] || 0) * 8 + "px";
            inline(li, item); element.append(li);
          }
          break;
        case ":table":
          element = node("table");
          for (const [row, header] of [[block.header || [], true], ...(block.rows || []).map(row => [row, false])]) {
            const tr = node("tr");
            for (const cell of row) { const td = node(header ? "th" : "td"); inline(td, cell); tr.append(td); }
            element.append(tr);
          }
          break;
        default: throw new Error("Unsupported documentation block kind: " + block.kind);
      }
      parent.append(element);
    }
  }
  async function fetchTopic(id) {
    const result = await api("document-query", {action: "topic", topic: id});
    topicSummary(result.topic);
    for (const section of result.sections || []) sections.set(topicSummary(section.topic).id, section);
    return result;
  }
  function sectionElement(record) {
    const section = sections.get(record.topic.id);
    if (!section) throw new Error("Documentation content was not returned for " + record.topic.title + ".");
    const article = node("article", undefined, "document-section");
    article.dataset.topic = record.topic.id;
    article.dataset.level = record.level;
    if (record.groupStart) article.classList.add("document-group-start");
    const heading = node(record.level ? "h3" : "h2");
    heading.append(topicButton(section.topic));
    article.append(heading);
    blocks(article, section.blocks);
    return article;
  }
  function renderTopics() {
    const panel = $("examiner-topics");
    let previousQuery = null;
    const fragments = viewer().sections.map(record => {
      const element = sectionElement({...record, groupStart: record.groupStart ?? record.query !== previousQuery});
      previousQuery = record.query;
      return element;
    });
    panel.replaceChildren(...fragments);
    if (!fragments.length) panel.append(node("p", "Select a candidate to read its documentation.", "document-empty"));
  }
  function renderBookmarks() {
    const panel = $("examiner-bookmarks");
    panel.replaceChildren();
    for (const read of [true, false]) {
      const group = node("div", undefined, read ? "read-bookmarks" : "deferred-bookmarks");
      for (const item of viewer().bookmarks.filter(item => item.viewed === read)) {
        const line = node("div", undefined, "document-bookmark");
        if (item.topic.id === viewer().current) { line.classList.add("current"); line.setAttribute("aria-current", "true"); }
        line.append(topicButton(item.topic, "bookmark"));
        group.append(line);
      }
      panel.append(group);
    }
    updatePaneTracks();
  }
  function renderCandidates() {
    const panel = $("examiner-candidates");
    const current = viewer().candidates[viewer().candidateIndex];
    panel.replaceChildren();
    if (!current) return;
    panel.append(node("div", current.title, "candidate-description"));
    if (current.mode) panel.append(node("div", "Search: " + label(current.mode) + (current.adjacent ? ", adjacent" : ", all terms"), "candidate-mode"));
    for (const topic of current.topics || []) {
      const line = topicButton(topic);
      const depth = current.action === "contents" ? Math.max(0, topic.depth || 0) : 0;
      line.style.marginLeft = depth * 16 + "px";
      line.dataset.depth = depth;
      panel.append(line);
    }
    if (!current.topics?.length) panel.append(node("p", "No matching topics."));
    updatePaneTracks();
  }
  async function candidates(action, args = {}) {
    const result = await api("document-query", {action, ...args});
    for (const topic of result.topics || []) topicSummary(topic);
    const current = viewer();
    if (result["search-options"] && !current.search) {
      current.search = {mode: result["search-options"].mode, adjacent: result["search-options"].adjacent};
    }
    current.candidates.push({...result, action});
    current.candidateIndex = current.candidates.length - 1;
    persist(); renderCandidates();
    $("examiner-candidates").scrollTop = 0;
  }
  function hideTypeout() {
    typeout = false;
    $("examiner-typeout").hidden = true;
    $("examiner-topics").hidden = false;
    $("examiner-pages").scrollTop = viewer().scroll;
    editor.focus(); updatePaneTracks();
  }
  function showTypeout(title) {
    if (!typeout) viewer().scroll = $("examiner-pages").scrollTop;
    typeout = true;
    const panel = $("examiner-typeout");
    panel.replaceChildren(node("h2", title));
    panel.hidden = false;
    $("examiner-topics").hidden = true;
    $("examiner-pages").scrollTop = 0;
    panel.focus();
    return panel;
  }
  function scrollToTopic(id) {
    const section = [...$("examiner-topics").children].find(item => item.dataset.topic === id);
    if (section) $("examiner-pages").scrollTop = section.offsetTop - $("examiner-topics").offsetTop;
    viewer().scroll = $("examiner-pages").scrollTop;
    persist(); updatePaneTracks();
  }
  async function readTopic(id) {
    const result = await fetchTopic(id);
    const current = viewer();
    const known = new Set(current.sections.map(item => item.topic.id));
    let groupStart = true;
    for (const section of result.sections || []) {
      if (!known.has(section.topic.id)) {
        current.sections.push({topic: section.topic, level: section.level || 0, query: result.topic.id, groupStart});
        groupStart = false;
        known.add(section.topic.id);
      }
    }
    let bookmark = current.bookmarks.find(item => item.topic.id === result.topic.id);
    if (!bookmark) { bookmark = {topic: result.topic, viewed: true}; current.bookmarks.push(bookmark); }
    else if (!bookmark.viewed) {
      current.bookmarks = current.bookmarks.filter(item => item !== bookmark);
      current.bookmarks.push(bookmark);
    }
    bookmark.viewed = true;
    bookmark.topic = result.topic;
    current.current = result.topic.id;
    hideTypeout(); renderTopics(); renderBookmarks(); scrollToTopic(result.topic.id);
  }
  function deferTopic(topic) {
    if (!viewer().bookmarks.some(item => item.topic.id === topic.id)) {
      viewer().bookmarks.push({topic, viewed: false});
      persist(); renderBookmarks();
    }
  }
  function discard(id) {
    const current = viewer();
    current.bookmarks = current.bookmarks.filter(item => item.topic.id !== id);
    current.sections = current.sections.filter(item => item.topic.id !== id);
    if (current.current === id) current.current = null;
    renderTopics(); renderBookmarks(); updatePaneTracks();
    current.scroll = $("examiner-pages").scrollTop;
    persist();
  }
  function relation(panel, label, topics) {
    if (!topics?.length) return;
    const row = node("p", label + ": ");
    topics.forEach((topic, index) => { if (index) row.append(", "); row.append(topicButton(topic)); });
    panel.append(row);
  }
  async function overview(id) {
    const result = await api("document-query", {action: "overview", topic: id});
    const panel = showTypeout("Overview of " + result.topic.title);
    panel.append(node("p", [result.topic.type, result.topic.title].filter(Boolean).join(": ")));
    if (result.topic.summary) panel.append(node("p", result.topic.summary));
    relation(panel, "Including topics", result.ancestors || (result.parent ? [result.parent] : []));
    if (result.topic.book) panel.append(node("p", "Document: " + result.topic.book));
    if (result.topic.keywords?.length) panel.append(node("p", "Keywords: " + result.topic.keywords.join(", ")));
    if (result.topic.source) {
      const source = node("p", "Source: ");
      inline(source, [{kind: ":link", text: result.topic.source, url: result.topic.source}]);
      source.className = "document-source";
      panel.append(source);
    }
    relation(panel, "Related topics", result.related);
    const tree = node("div", undefined, "document-tree");
    if (result.parent) tree.append(topicButton(result.parent));
    const branch = node("div", undefined, "document-tree-branch");
    for (const topic of result.siblings || []) if (topic.id !== result.topic.id) branch.append(topicButton(topic));
    const selected = topicButton(result.topic); selected.classList.add("selected"); branch.append(selected);
    const children = node("div", undefined, "document-tree-branch");
    for (const topic of result.children || []) children.append(topicButton(topic));
    branch.append(children); tree.append(branch); panel.append(tree);
    panel.append(button("Press SPACE to return to the viewer.", async () => hideTypeout()));
    updatePaneTracks();
  }
  function chooseViewer(remove = false) {
    menu(remove ? "Remove Viewer" : "Select Viewer", saved.viewers.map(item => [item.name,
      () => remove ? removeViewer(item.name) : selectViewer(item.name)]));
  }
  async function selectViewer(name) {
    if (!name) return chooseViewer();
    if (!saved.viewers.some(item => item.name === name)) saved.viewers.push(newViewer(name));
    if (saved.current !== name) { saved.previous = saved.current; saved.current = name; }
    persist(); await show(); editor.focus();
  }
  async function removeViewer(name) {
    if (!name) return chooseViewer(true);
    if (!saved.viewers.some(item => item.name === name)) throw new Error("No viewer named " + name + ".");
    saved.viewers = saved.viewers.filter(item => item.name !== name);
    if (!saved.viewers.length) saved.viewers.push(newViewer("Default Viewer"));
    if (saved.current === name) saved.current = saved.viewers[0].name;
    if (saved.previous === name) saved.previous = null;
    persist(); await show();
  }
  function reselectCandidates() {
    menu("Reselect Candidates", viewer().candidates.map((item, index) => [item.title + " (" + (index + 1) + ")", async () => {
      viewer().candidateIndex = index;
      persist(); renderCandidates();
    }]));
  }
  async function searchOptions() {
    const current = viewer();
    let options = current.candidates.find(item => item["search-options"])?.["search-options"];
    if (!options) {
      const catalog = await api("document-query", {action: "catalog"});
      options = catalog["search-options"];
      if (!options) throw new Error("The guest catalog did not supply search options.");
      if (current.candidates.length) current.candidates[0]["search-options"] = options;
      persist();
    }
    current.search ??= {mode: options.mode, adjacent: options.adjacent};
    menu("Show Candidates options", [
      ...options.modes.map(item => [(current.search.mode === item.value ? "● " : "○ ") + item.label, async () => {
        current.search.mode = item.value; persist(); await searchOptions();
      }]),
      [(current.search.adjacent ? "● " : "○ ") + "Adjacent words", async () => {
        current.search.adjacent = !current.search.adjacent; persist(); await searchOptions();
      }]
    ]);
    [...$("examiner-menu-items").children].forEach((item, index) => {
      if (index < options.modes.length) item.dataset.searchMode = options.modes[index].value;
      else if (index === options.modes.length) item.id = "examiner-adjacent";
    });
  }
  async function hardcopyTopics(ids) {
    const print = node("div"); print.id = "examiner-print-topic";
    const included = new Set();
    for (const id of ids) {
      const result = await fetchTopic(id);
      let groupStart = true;
      for (const section of result.sections || []) {
        if (included.has(section.topic.id)) continue;
        print.append(sectionElement({...section, groupStart}));
        included.add(section.topic.id); groupStart = false;
      }
    }
    document.body.append(print);
    document.body.classList.add("print-document-topic");
    try { window.print(); }
    finally { document.body.classList.remove("print-document-topic"); print.remove(); }
  }
  async function hardcopyTopic(id) { await hardcopyTopics([id]); }
  async function privateDocument(operation, pathname, source) {
    if (operation === "save-private-document") {
      const topics = [true, false].flatMap(viewed => viewer().bookmarks
        .filter(item => item.viewed === viewed).map(item => item.topic.id));
      const name = freshName();
      await mutate(operation, {name, pathname, topics}, {source});
      await refresh();
      message("Save job " + name.slice(0, 12) + " accepted. See Evaluations for its result.");
      return;
    }
    const result = await api("read-private-document", {pathname});
    const topics = result.topics.map(topicSummary);
    if (operation === "read-private-document") {
      for (const topic of topics) await readTopic(topic.id);
    } else if (operation === "load-private-document") {
      for (const topic of topics) deferTopic(topic);
    } else if (operation === "hardcopy-private-document") {
      await hardcopyTopics(topics.map(topic => topic.id));
    }
  }
  async function execute(source) {
    if (!source.trim()) return;
    const plan = await api("document-assistance", {source, cursor: Array.from(source).length, action: "parse"});
    if (plan.error) { renderAssistance(editor, plan, source, editorCursor(editor), "help"); return; }
    const argument = plan.argument;
    switch (plan.operation) {
      case "topic": await readTopic(argument); break;
      case "search": {
        const options = {...viewer().search, ...(plan.mode ? {mode: plan.mode} : {}),
          ...(plan.adjacent === undefined ? {} : {adjacent: plan.adjacent})};
        await candidates("search", {query: argument,
          ...(options.mode ? {mode: options.mode.replace(/^:/, "")} : {}),
          ...(options.adjacent === undefined ? {} : {adjacent: options.adjacent})});
        break;
      }
      case "contents": await candidates("contents", {topic: argument}); break;
      case "overview": await overview(argument); break;
      case "help": {
        const panel = showTypeout("Document Examiner commands");
        panel.append(node("pre", plan.help || "Request command completion with Tab and contextual help with F12."));
        panel.append(button("Press SPACE to return to the viewer.", async () => hideTypeout()));
        break;
      }
      case "documentation": await readTopic(argument); break;
      case "select-viewer": await selectViewer(argument); break;
      case "remove-viewer": await removeViewer(argument); break;
      case "reselect-candidates": reselectCandidates(); break;
      case "hardcopy-viewer": {
        hideTypeout(); message("Printing the current viewer with the browser's printer settings."); window.print(); break;
      }
      case "save-private-document": case "read-private-document":
      case "load-private-document": case "hardcopy-private-document":
        await privateDocument(plan.operation, argument, source); break;
      default: throw new Error("Unsupported Document Examiner operation: " + plan.operation);
    }
    $("examiner-command-output").replaceChildren(commandPrompt(), " " + source);
    if (editor.value === source) setEditor(editor, "", 0);
    updatePaneTracks();
  }
  function queueCommand() { const source = editor.value; return run(() => execute(source)); }
  async function show() {
    const current = viewer();
    if (renderedViewer !== current) {
      loading = true;
      try {
        for (const query of new Set(current.sections.filter(item => !sections.has(item.topic.id)).map(item => item.query))) {
          await fetchTopic(query);
        }
        typeout = false; $("examiner-typeout").hidden = true; $("examiner-topics").hidden = false;
        renderTopics(); renderBookmarks(); renderCandidates();
        $("examiner-viewer-label").textContent = "Viewer: " + current.name;
        await document.fonts.ready;
        $("examiner-pages").scrollTop = current.scroll;
        current.scroll = $("examiner-pages").scrollTop;
        persist();
        renderedViewer = current;
      } finally { loading = false; }
    }
    if (!current.candidates.length) await candidates("catalog");
    updatePaneTracks();
  }
  function updatePaneTracks() {
    const columns = Math.round($("examiner").clientWidth * 0.574) + "px minmax(0, 1fr)";
    $("examiner-reading").style.gridTemplateColumns = columns;
    $("examiner-commands").style.gridTemplateColumns = columns;
    $("examiner-right").style.gridTemplateRows = Math.floor($("examiner-right").clientHeight / 2) + "px minmax(0, 1fr)";
    placeTextOnPixels($("examiner-viewer").querySelector("h1"));
    const menu = $("examiner-command-menu"), menuStyle = getComputedStyle(menu);
    const menuWidth = menu.clientWidth - parseFloat(menuStyle.paddingLeft) - parseFloat(menuStyle.paddingRight) - parseFloat(menuStyle.columnGap);
    menu.style.gridTemplateColumns = Math.floor(menuWidth / 2) + "px minmax(0, 1fr)";
    for (const table of $("examiner-pages").querySelectorAll("table")) {
      let columns = table.querySelector("colgroup");
      if (!columns) {
        columns = node("colgroup");
        for (let index = 0; index < table.rows[0].cells.length; index++) columns.append(node("col"));
        table.prepend(columns);
      }
      const tableStyle = getComputedStyle(table);
      const width = table.parentElement.clientWidth - parseFloat(tableStyle.borderLeftWidth) - parseFloat(tableStyle.borderRightWidth);
      const count = columns.children.length;
      [...columns.children].forEach((column, index) => {
        column.style.width = (index === count - 1 ? width - Math.floor(width / count) * index : Math.floor(width / count)) + "px";
      });
    }
    for (const panel of document.querySelectorAll(".examiner-scroll")) {
      const content = panel.querySelector(".examiner-scroll-content");
      const track = panel.querySelector(".examiner-track");
      const thumb = track.firstElementChild;
      thumb.style.height = Math.min(1, content.clientHeight / Math.max(1, content.scrollHeight)) * 100 + "%";
      thumb.style.marginTop = content.scrollTop / Math.max(1, content.scrollHeight) * track.clientHeight + "px";
    }
    const content = $("examiner-pages"), track = $("examiner-horizontal-track");
    track.firstElementChild.style.width = Math.min(1, content.clientWidth / Math.max(1, content.scrollWidth)) * 100 + "%";
    track.firstElementChild.style.marginLeft = content.scrollLeft / Math.max(1, content.scrollWidth) * track.clientWidth + "px";
  }
  for (const panel of document.querySelectorAll(".examiner-scroll")) {
    const content = panel.querySelector(".examiner-scroll-content");
    const track = panel.querySelector(".examiner-track");
    content.onscroll = () => {
      updatePaneTracks();
      if (content.id === "examiner-pages" && !typeout && !loading) {
        viewer().scroll = content.scrollTop;
        clearTimeout(scrollTimer); scrollTimer = setTimeout(() => run(async () => persist()), 200);
      }
    };
    track.onclick = event => {
      content.scrollTop = (event.clientY - track.getBoundingClientRect().top) / track.clientHeight
        * (content.scrollHeight - content.clientHeight);
    };
  }
  $("examiner-horizontal-track").onclick = event => {
    const content = $("examiner-pages"), track = $("examiner-horizontal-track");
    content.scrollLeft = (event.clientX - track.getBoundingClientRect().left) / track.clientWidth
      * (content.scrollWidth - content.clientWidth);
  };
  $("examiner-command-form").onsubmit = event => { event.preventDefault(); queueCommand(); };
  editor.onkeydown = event => {
    if (event.altKey && ["Tab", "F11"].includes(event.key)) {
      event.preventDefault(); run(async () => searchOptions());
    } else if (event.ctrlKey && event.key === "?") {
      event.preventDefault(); event.stopPropagation(); chooseViewer();
    } else editorKey(editor, event);
  };
  editor.oninput = event => editorChanged(editor, event);
  editor.onclick = () => scheduleAssistance(editor, "inspect");
  $("examiner").addEventListener("keydown", event => {
    if (typeout && event.key === " " && event.target !== editor) {
      event.preventDefault(); hideTypeout();
    } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "l") {
      event.preventDefault(); if (saved.previous) run(() => selectViewer(saved.previous));
    } else if (event.ctrlKey && event.key === "?" && event.target !== editor) {
      event.preventDefault(); chooseViewer();
    }
  });
  $("examiner-viewer-label").onclick = () => chooseViewer();
  $("examiner-viewer-label").oncontextmenu = event => {
    event.preventDefault(); event.stopPropagation();
    menu("Viewer: " + viewer().name, [
      ["Select Viewer", async () => chooseViewer()],
      ["Remove Viewer", () => removeViewer(viewer().name)],
      ["Hardcopy Viewer", () => execute("Hardcopy Viewer")]
    ]);
  };
  function promptCommand(source) {
    setEditor(editor, source, Array.from(source).length); editor.focus();
    if (source.endsWith(" ")) scheduleAssistance(editor, "inspect");
    else queueCommand();
  }
  for (const item of document.querySelectorAll("[data-examiner-command]")) {
    item.onclick = () => promptCommand(item.dataset.examinerCommand);
    if (item.dataset.examinerCommand === "Read Private Document ") {
      item.dataset.help = "Mouse-L: Read a private document. Mouse-R: Save, Load, or Hardcopy.";
      item.oncontextmenu = event => {
        event.preventDefault(); event.stopPropagation();
        menu("Private documents", ["Save Private Document", "Load Private Document", "Hardcopy Private Document"]
          .map(command => [command, async () => promptCommand(command + " ")]));
      };
    }
    if (item.dataset.examinerCommand === "Help") item.onauxclick = event => {
      if (event.button === 1) { event.preventDefault(); run(() => execute("Document Examiner Documentation")); }
    };
    if (item.dataset.examinerCommand === "Show Candidates ") {
      item.dataset.help = "Mouse-L: Enter search terms. Mouse-R or Alt-COMPLETE: Search options.";
      item.oncontextmenu = event => {
        event.preventDefault(); event.stopPropagation(); run(async () => searchOptions());
      };
    }
  }
  new ResizeObserver(updatePaneTracks).observe($("examiner"));
  window.addEventListener("pagehide", () => { clearTimeout(scrollTimer); persist(); });
  return {show, queueCommand};
})();
