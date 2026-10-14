"use strict";

const $ = id => document.getElementById(id);
const storageKey = "mezzano-monitor-v1";
const defaultState = {session: null, attempted: false, jobs: {}, pending: [], commands: [],
                      package: "CL-USER", interactive: false, history: [], inputHistory: [], nextInputSequence: 0, initialHerald: null, drafts: {}};
let state = defaultState;
let storageError = null;
try {
  const saved = sessionStorage.getItem(storageKey);
  if (saved) state = {...defaultState, ...JSON.parse(saved)};
} catch (error) {
  storageError = error;
}
for (const draft of Object.values(state.drafts)) delete draft.frame;
for (const [index, item] of state.inputHistory.entries()) {
  if (!Number.isSafeInteger(item.sequence)) item.sequence = index;
  state.nextInputSequence = Math.max(state.nextInputSequence, item.sequence + 1);
}
let connected = false;
let busy = false;
let actions = Promise.resolve();
let activity = "listener";
let selectedStop = null;
const frameCommands = ["current-frame", "select-frame", "next-frame", "previous-frame", "top-frame", "bottom-frame"];
let stops = [];
let activeListenerJob = null;
let listenerDebugger = null;
let listenerPrompt = "Command: ";
const editorDraftKeys = new Map();
let historyIndex = null;
let selectingActivity = false;
let selectHelpFocus = null;
const assistanceTimers = new Map();
const views = new Map();
const commandResults = new Map();
let stopControls = new Map();

function save() {
  sessionStorage.setItem(storageKey, JSON.stringify(state));
}
function freshName() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
}
function label(value) {
  return value ? value.replace(/^:/, "").replaceAll("-", " ") : "unknown";
}
function shortIdentity(text) {
  return text.replace(/[0-9a-f]{64}/g, name => name.slice(0, 12));
}
function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function message(text) {
  $("message").textContent = text;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function placeTextOnPixels(element) {
  let text = element.querySelector(":scope > .pixel-text");
  if (!text) {
    text = node("span", undefined, "pixel-text");
    text.append(...element.childNodes);
    element.append(text);
  }
  text.style.left = text.style.top = "0px";
  const position = text.getBoundingClientRect();
  text.style.left = (Math.round(position.left) - position.left) + "px";
  text.style.top = (Math.round(position.top) - position.top) + "px";
}
function placeDialogOnPixels(dialog) {
  document.fonts.ready.then(() => {
    if (!dialog.open) return;
    dialog.style.margin = "0";
    dialog.style.left = Math.max(8, Math.round((innerWidth - dialog.offsetWidth) / 2)) + "px";
    dialog.style.top = Math.max(8, Math.round((innerHeight - dialog.offsetHeight) / 2)) + "px";
    for (const item of dialog.querySelectorAll("h2, h3, button")) placeTextOnPixels(item);
  }).catch(report);
}
function button(text, action, help) {
  const element = node("button", text);
  element.type = "button";
  element.onclick = () => run(action);
  if (help) element.dataset.help = help;
  return element;
}
function report(error) {
  message(error.reason === ":listener-busy"
    ? "Input was rejected because this Listener already had an active evaluation. Your input is preserved."
    : error.reason === ":no-continue-restart"
      ? "No default CONTINUE restart. Choose a restart or use :Proceed N."
    : error.reason === ":invalid-frame"
      ? "The requested frame is outside this stack. The current frame is unchanged."
    : [":released-inspection-reference", ":expired-inspection-reference"].includes(error.reason)
      ? "This Inspector reference is no longer valid. Inspect the value again."
    : error.message || String(error));
  if (error.reason === ":expired-session") connected = false;
  $("process-state").textContent = connected ? "Request Error" : "Disconnected";
}
function run(action) {
  const perform = async () => {
    busy = true;
    updateStatus();
    try {
      await action();
    } catch (error) {
      report(error);
      if (error.reason === ":expired-session") {
        try {
          await newSession();
          message("Session expired. Connected with a new session. Recorded requests remain in Request History and were not replayed.");
        } catch (recoveryError) {
          report(recoveryError);
        }
      }
    } finally {
      busy = false;
      updateStatus();
    }
  };
  actions = actions.then(perform, perform);
  return actions;
}
async function api(operation, arguments_ = {}) {
  let response;
  try {
    response = await fetch("/api", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Mezzano-Request": "1"},
      body: JSON.stringify({session: state.session, operation, arguments: arguments_}),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    connected = false;
    error.uncertain = true;
    throw error;
  }
  let reply;
  try {
    reply = await response.json();
  } catch (error) {
    error.uncertain = true;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(reply.error || "HTTP request failed.");
    error.reason = reply.error;
    error.uncertain = reply.uncertain !== false;
    if (response.status >= 500 || error.reason === ":expired-session") connected = false;
    throw error;
  }
  if (reply.diagnostics?.length) message(reply.diagnostics.join(""));
  return reply.value;
}
async function connect() {
  if (!state.session) {
    state.session = freshName();
    state.attempted = false;
    save();
  }
  const operation = state.attempted ? "resume-session" : "open-session";
  state.attempted = true;
  save();
  await api(operation);
  connected = true;
  message("Session " + state.session.slice(0, 12) + ".  Mouse-Right: System Menu.");
  await refresh();
}
async function newSession() {
  if (connected) throw new Error("Release the current session before replacing it.");
  if (state.session) {
    state.history.push({session: state.session, pending: state.pending, commands: state.commands});
  }
  state.pending = [];
  state.session = null;
  state.attempted = false;
  state.commands = [];
  selectedStop = null;
  commandResults.clear();
  views.clear();
  $("transcript").replaceChildren();
  for (const job of Object.values(state.jobs)) job.token = null;
  save();
  $("system-menu").close();
  await connect();
  showActivity(activity);
}
function removeJob(token) {
  for (const [name, job] of Object.entries(state.jobs)) {
    if (same(job.token, token)) {
      delete state.jobs[name];
      views.get(name)?.element.remove();
      views.delete(name);
    }
  }
}
function applyMutation(record, result) {
  const args = record.arguments;
  if (["start-evaluation", "start-listener", "save-private-document"].includes(record.operation)) {
    state.jobs[args.name] = {...state.jobs[args.name], name: args.name, source: args.source ?? record.source,
      token: result, listener: record.operation === "start-listener", clearBefore: record.clearBefore,
      clearState: record.clearState};
    if (record.operation === "start-listener"
        && !state.jobs[args.name].receipt
        && !state.inputHistory.some(item => item.name === args.name)) {
      state.inputHistory.push({name: args.name, source: args.source,
        sequence: record.inputSequence ?? state.nextInputSequence++});
      state.inputHistory.sort((left, right) => left.sequence - right.sequence);
    }
  } else if (record.operation === "submit") {
    const command = {stop: args.stop, id: args.id, command: args.command, argument: args.argument,
      display: record.display, localIndex: record.localIndex, source: record.source};
    if (!state.commands.some(item => same(item.stop, command.stop) && item.id === command.id)) {
      state.commands.push(command);
    }
  } else if (record.operation === "release-job") {
    removeJob(args.job);
  } else if (record.operation === "release-stop") {
    state.commands = state.commands.filter(command => !same(command.stop, args.stop));
    if (same(selectedStop, args.stop)) selectedStop = null;
  } else if (record.operation === "release-session") {
    state.session = null;
    state.attempted = false;
    state.commands = [];
    state.pending = [];
    selectedStop = null;
    connected = false;
    for (const job of Object.values(state.jobs)) job.token = null;
  }
}
async function replay(record) {
  if (record.session !== state.session) throw new Error("This request belongs to a different session.");
  record.status = "awaiting reply";
  save();
  renderPending();
  try {
    const result = await api(record.operation, record.arguments);
    applyMutation(record, result);
    state.pending = state.pending.filter(item => item.id !== record.id);
    save();
    renderPending();
    return result;
  } catch (error) {
    record.status = error.uncertain ? "outcome unknown" : "rejected";
    record.error = error.message;
    save();
    renderPending();
    throw error;
  }
}
function archive(record) {
  state.history.push({session: record.session, pending: [record], commands: []});
  state.pending = state.pending.filter(item => item.id !== record.id);
  save();
  renderPending();
}
async function reconcileRelease(record) {
  if (record.session !== state.session) throw new Error("This request belongs to a different session.");
  const query = {"release-job": "job-information", "release-stop": "information",
                 "release-session": "resume-session"}[record.operation];
  try {
    await api(query, record.arguments);
    record.status = "retained at last check; original release outcome unknown";
  } catch (error) {
    if ([":released-job", ":released-stop"].includes(error.reason)) {
      record.status = "object released; original release reply was lost";
      applyMutation(record, null);
      archive(record);
      return;
    }
    if ([":expired-session", ":expired-job", ":expired-stop"].includes(error.reason)) {
      record.status = "reference expired; original release outcome unknown";
      archive(record);
      if (error.reason === ":expired-session") throw error;
      return;
    }
    throw error;
  }
  save();
  renderPending();
}
async function mutate(operation, arguments_, metadata = {}) {
  if (!connected) throw new Error("Connect or resume the session first.");
  const record = {...metadata, id: freshName(), session: state.session, operation, arguments: arguments_, status: "awaiting reply"};
  if (operation === "start-listener") record.inputSequence = state.nextInputSequence++;
  state.pending.push(record);
  save();
  return replay(record);
}
function debuggerDraftKey(stop) {
  return "debugger:" + JSON.stringify(stop);
}
function storeEditorDraft(editor) {
  const key = editorDraftKeys.get(editor);
  if (!key) return;
  state.drafts[key] = {...state.drafts[key], text: editor.value, start: editor.selectionStart,
    end: editor.selectionEnd, direction: editor.selectionDirection};
  save();
}
function useEditorDraft(editor, key, reload = false) {
  const prior = editorDraftKeys.get(editor);
  if (prior === key && !reload) return;
  if (prior !== key) storeEditorDraft(editor);
  editorDraftKeys.set(editor, key);
  const draft = state.drafts[key];
  clearAssistance(editor);
  editor.value = draft?.text || "";
  editor.setSelectionRange(draft?.start || 0, draft?.end || 0, draft?.direction || "none");
  if (editor.id === "source") resizeSource();
}
function activateStop(stop) {
  if (same(selectedStop, stop)) return;
  selectedStop = stop;
}
function updateListenerInput(reload = false) {
  const stop = listenerDebugger?.stop;
  useEditorDraft($("source"), stop ? debuggerDraftKey(stop) : "listener", reload);
  $("source").dataset.debuggerStop = stop ? JSON.stringify(stop) : "";
  $("listener-prompt").textContent = listenerDebugger?.prompt || listenerPrompt;
  if (activity === "listener" && stop) activateStop(stop);
}
function showActivity(name) {
  const previous = activity;
  if (previous === "listener") storeEditorDraft($("source"));
  else if (previous === "debugger") storeEditorDraft($("debugger-command"));
  activity = name;
  $("monitor").classList.toggle("examiner-active", name === "examiner");
  document.querySelectorAll(".activity").forEach(element => { element.hidden = element.id !== name; });
  const labels = {listener: "Dynamic Lisp Listener 1", debugger: "Debugger", evaluations: "Evaluations",
                  requests: "Request History", help: "Listener Help", "input-history": "Input History",
                  examiner: "Document Examiner", peek: "Peek"};
  $("window-label").textContent = labels[name];
  $("system-menu").close();
  if (name === "listener") $("source").focus();
  else if (name === "debugger" && selectedStop) $("debugger-command").focus();
  else if (name === "examiner") { $("examiner-command").focus(); run(() => examiner.show()); }
  else $("page").focus();
  updateListenerInput(name === "listener");
  renderStops();
  if (name === "debugger" && selectedStop) {
    useEditorDraft($("debugger-command"), debuggerDraftKey(selectedStop), true);
  }
  updateTracks();
  document.dispatchEvent(new CustomEvent("activitychange", {detail: {name, previous}}));
}
function queueEvaluation() {
  const source = $("source").value;
  const interactive = $("interactive").checked;
  const stop = listenerDebugger?.stop;
  return stop ? queueDebuggerInput($("source"), source, stop)
    : run(() => evaluate(source, interactive));
}
async function evaluate(source, interactive) {
  if (!source.trim()) return;
  state.interactive = interactive;
  const clearBefore = Object.values(state.jobs).filter(job => !job.hidden).map(job => job.name);
  const clearState = {pending: state.pending.map(record => record.id),
    commands: state.commands.map(commandKey), history: state.history.length,
    inputSequence: state.nextInputSequence};
  await mutate("start-listener", {name: freshName(), source, interactive}, {clearBefore, clearState});
  if ($("source").value === source) setEditor($("source"), "", 0);
  historyIndex = null;
  showActivity("listener");
  await refresh();
  if (document.activeElement === $("source")) $("page").scrollTop = $("page").scrollHeight;
}
function editorCursor(editor) {
  return Array.from(editor.value.slice(0, editor.selectionStart)).length;
}
function setEditor(editor, text, cursor) {
  clearAssistance(editor);
  editor.value = text;
  const offset = Array.from(text).slice(0, cursor).join("").length;
  editor.setSelectionRange(offset, offset);
  if (editor.id === "source") resizeSource();
  storeEditorDraft(editor);
}
function editorContext(editor) {
  return editor.id === "source" ? (listenerDebugger ? "debugger" : "listener")
    : editor.id === "examiner-command" ? "examiner" : "debugger";
}
function assistancePanel(editor) {
  return $(editor.id === "source" ? "listener-assistance" : editorContext(editor) + "-assistance");
}
function clearAssistance(editor) {
  assistancePanel(editor).replaceChildren();
}
function renderAssistance(editor, result, source, cursor, action) {
  const panel = assistancePanel(editor);
  panel.replaceChildren();
  if (result.prompt) {
    const prompt = node("pre", result.prompt, "argument-prompt");
    if (result.default != null) prompt.dataset.default = result.default;
    if (result["expected-type"]) prompt.dataset.expectedType = result["expected-type"];
    panel.append(prompt);
  }
  if (result.error) panel.append(node("pre", result.error, "assistance-error"));
  if (result.help) panel.append(node("pre", result.help));
  for (const candidate of ["help", "complete"].includes(action) ? result.candidates || [] : []) {
    const choice = button(candidate.label, async () => {
      if (editor.value !== source || editorCursor(editor) !== cursor) {
        throw new Error("Input changed; request completion again.");
      }
      setEditor(editor, candidate.text, candidate.cursor);
      editor.focus();
      clearAssistance(editor);
      scheduleAssistance(editor, "inspect");
    }, candidate.help);
    panel.append(choice);
  }
  updateTracks();
  if (!editor.closest(".activity")?.hidden) editor.scrollIntoView({block: "nearest"});
}
function scheduleAssistance(editor, action, presentation) {
  clearTimeout(assistanceTimers.get(editor));
  const source = editor.value;
  const cursor = editorCursor(editor);
  const context = editorContext(editor);
  const draftKey = editorDraftKeys.get(editor);
  const request = () => run(async () => {
    if (!connected || editor.value !== source || editorCursor(editor) !== cursor
        || context !== editorContext(editor) || draftKey !== editorDraftKeys.get(editor)) return;
    const result = await api(context === "examiner" ? "document-assistance" : "listener-assistance", {
      source, cursor, action, ...(context === "examiner" ? {} : {context}),
      ...(presentation === undefined ? {} : {presentation})});
    if (editor.value !== source || editorCursor(editor) !== cursor
        || context !== editorContext(editor) || draftKey !== editorDraftKeys.get(editor)) return;
    if (action !== "inspect" && !result.error) setEditor(editor, result.text, result.cursor);
    renderAssistance(editor, result, editor.value, editorCursor(editor), action);
    if (action !== "inspect" && action !== "help" && !result.error
        && (editor.value !== source || editorCursor(editor) !== cursor)) {
      scheduleAssistance(editor, "inspect");
    }
  });
  if (action === "inspect") assistanceTimers.set(editor, setTimeout(request, 150));
  else request();
}
function recallInput(index) {
  const item = state.inputHistory[index];
  if (!item) throw new Error("No earlier Listener input.");
  historyIndex = index;
  setEditor($("source"), item.source, Array.from(item.source).length);
  showActivity("listener");
  scheduleAssistance($("source"), "inspect");
}
function renderInputHistory() {
  const panel = $("inputs");
  panel.replaceChildren();
  for (let index = state.inputHistory.length - 1; index >= 0; index--) {
    const item = state.inputHistory[index];
    const choice = button(item.source, async () => recallInput(index),
      "Mouse-Left: Insert this input. Return executes it as a new request.");
    choice.title = item.name;
    panel.append(choice);
  }
  if (!state.inputHistory.length) panel.textContent = "No accepted Listener input in this tab.";
}
function editorKey(editor, event) {
  if (event.key === "Tab" || (event.key === "F11" && !event.shiftKey)) {
    event.preventDefault();
    scheduleAssistance(editor, "complete");
  } else if (event.key === "F12" || (event.ctrlKey && event.key === "?")) {
    event.preventDefault();
    scheduleAssistance(editor, "help");
  } else if (event.key === "F10") {
    event.preventDefault();
    setEditor(editor, "", 0);
    clearAssistance(editor);
  } else if (editor.id === "source" && event.altKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    run(async () => recallInput(event.ctrlKey || historyIndex === null
      ? state.inputHistory.length - 1 : historyIndex - 1));
  } else if (editor.id === "source" && event.key === "Escape") {
    event.preventDefault();
    renderInputHistory();
    showActivity("input-history");
  } else if ((event.key === "Enter" && !event.shiftKey)
             || (event.key === "F11" && event.shiftKey)) {
    event.preventDefault();
    if (editor.id === "source") queueEvaluation();
    else if (editor.id === "examiner-command") examiner.queueCommand();
    else queueDebuggerCommand();
  }
}
function editorChanged(editor, event) {
  storeEditorDraft(editor);
  clearAssistance(editor);
  if (editor.id === "source") { historyIndex = null; resizeSource(); }
  scheduleAssistance(editor, event.inputType === "insertText" && event.data === " " ? "space" : "inspect");
}
function heraldInline(parent, line) {
  if (!Array.isArray(line)) throw new Error("Invalid herald line.");
  for (const part of line) {
    if (typeof part.text !== "string") throw new Error("Invalid herald text.");
    if (part.kind === ":text") parent.append(document.createTextNode(part.text));
    else if (part.kind === ":emphasis") parent.append(node("em", part.text));
    else if (part.kind === ":key") {
      const key = node("kbd", part.text, "herald-key");
      const outline = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      outline.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(outline.namespaceURI, "path");
      outline.append(path); key.append(outline); parent.append(key);
    } else throw new Error("Unknown herald inline kind: " + part.kind);
  }
}
function renderHerald(payload) {
  if (typeof payload?.title !== "string" || !Array.isArray(payload.facts) || !Array.isArray(payload.help)) {
    throw new Error("Invalid herald presentation.");
  }
  const herald = node("section", undefined, "herald");
  herald.setAttribute("aria-label", "System herald");
  herald.dataset.detailed = String(Boolean(payload["detailed-p"]));
  const summary = node("div", undefined, "herald-summary");
  summary.append(node("h1", payload.title, "herald-title"));
  const facts = node("div", undefined, "herald-facts");
  for (const line of payload.facts) { const row = node("p"); heraldInline(row, line); facts.append(row); }
  summary.append(facts);
  if (payload["detailed-p"]) {
    const systems = payload.systems || [];
    if (!Array.isArray(systems)) throw new Error("Invalid herald systems.");
    const tables = node("div", undefined, "herald-systems");
    const split = Math.ceil(systems.length / 2);
    for (const group of [systems.slice(0, split), systems.slice(split)]) {
      const table = node("table");
      table.setAttribute("aria-label", "Loaded ASDF systems");
      for (const system of group) {
        if (typeof system.name !== "string" || (system.version !== null && typeof system.version !== "string")) {
          throw new Error("Invalid herald system record.");
        }
        const row = node("tr");
        const version = node("td", system.version ?? "-");
        if (system.version === null) version.title = "Version not specified.";
        row.append(node("td", system.name), version); table.append(row);
      }
      tables.append(table);
    }
    if (!systems.length) tables.append(node("p", "No ASDF systems loaded."));
    summary.append(tables);
  }
  const help = node("div", undefined, "herald-help");
  for (const line of payload.help) { const row = node("p"); heraldInline(row, line); help.append(row); }
  herald.append(summary, help);
  return herald;
}

function renderOutput(view, presentations, totalLength = Array.from(view.text).length) {
  const signature = JSON.stringify([view.text, presentations, totalLength]);
  if (signature === view.outputSignature) return;
  const chars = Array.from(view.text);
  const pieces = [];
  let offset = 0;
  let previousEnd = 0;
  for (const presentation of presentations || []) {
    if (!Number.isInteger(presentation.start) || !Number.isInteger(presentation.end)
        || presentation.start < previousEnd || presentation.end < presentation.start || presentation.end > totalLength) {
      throw new Error("Invalid Listener presentation range.");
    }
    previousEnd = presentation.end;
    if (![":pathname", ":herald"].includes(presentation.type)) {
      throw new Error("Unknown Listener presentation type: " + presentation.type);
    }
    if (presentation.end > chars.length) continue;
    pieces.push(document.createTextNode(chars.slice(offset, presentation.start).join("")));
    if (presentation.type === ":pathname") {
      if (typeof presentation.value !== "string") throw new Error("Invalid pathname presentation.");
      const pathname = button(chars.slice(presentation.start, presentation.end).join(""), async () => {
        showActivity("listener");
        scheduleAssistance($("source"), "insert", presentation.value);
      }, "Mouse-Left: Insert this pathname into the current command argument.");
      pathname.className = "presentation";
      pathname.title = presentation.value;
      pieces.push(pathname);
    } else if (presentation.type === ":herald") pieces.push(renderHerald(presentation.herald));
    else throw new Error("Unknown Listener presentation type: " + presentation.type);
    offset = presentation.end;
  }
  pieces.push(document.createTextNode(chars.slice(offset).join("")));
  view.output.replaceChildren(...pieces);
  view.outputSignature = signature;
  placeHeraldOnPixels();
}
function applyListenerEffects(job, info) {
  const result = info["listener-result"];
  if (![":returned", ":aborted", ":unwound"].includes(info.state)
      || job.effectsApplied || !result) return;
  if (!job.listener && !result.effects?.some(effect => effect.operation === ":clear-all")) return;
  for (const effect of result.effects || []) {
    if (effect.operation === ":clear-output-history") {
      if (state.initialHerald?.session === state.session) state.initialHerald.hidden = true;
      for (const name of job.clearBefore || []) {
        if (state.jobs[name]) state.jobs[name].hidden = true;
        if (views.has(name)) views.get(name).element.hidden = true;
      }
    } else if (effect.operation === ":clear-all") {
      const targets = new Set(effect.jobs || []);
      const stopped = stops.filter(stop => (effect.stops || []).includes(stop.info.id));
      const commandKeys = new Set(job.clearState?.commands || []);
      for (const command of state.commands) {
        if (stopped.some(stop => same(stop.token, command.stop))) commandKeys.add(commandKey(command));
      }
      for (const name of targets) {
        delete state.jobs[name];
        views.get(name)?.element.remove();
        views.delete(name);
      }
      const pending = new Set(job.clearState?.pending || []);
      state.pending = state.pending.filter(record => !pending.has(record.id));
      state.commands = state.commands.filter(command => !commandKeys.has(commandKey(command)));
      for (const key of commandKeys) commandResults.delete(key);
      if (stopped.some(stop => same(stop.token, selectedStop))) {
        selectedStop = null;
      }
      if (job.clearState) {
        state.history = state.history.slice(job.clearState.history).map(record => ({...record,
          pending: record.pending.filter(item => !pending.has(item.id)),
          commands: record.commands.filter(item => !commandKeys.has(commandKey(item)))}))
          .filter(record => record.pending.length || record.commands.length);
      }
      if (job.listener || job.clearState) {
        state.inputHistory = state.inputHistory.filter(item => item.name !== job.name
          && !targets.has(item.name)
          && (!job.clearState || item.sequence >= job.clearState.inputSequence));
        historyIndex = null;
        if (state.initialHerald) state.initialHerald.hidden = true;
      }
      job.hidden = true;
      job.receipt = true;
    } else throw new Error("Unknown Listener display effect: " + effect.operation);
  }
  job.effectsApplied = true;
}
function resizeSource() {
  $("source").style.height = "12px";
  $("source").style.height = $("source").scrollHeight + "px";
}
async function sendInput(job, view, eof) {
  const text = view.input.value + (view.input.value ? "\n" : "");
  await mutate("job-input", {job: job.token, offset: view.info["input-length"], text, eof});
  view.input.value = "";
  await refresh();
}
function createView(job) {
  const element = node("article", undefined, "evaluation");
  element.dataset.job = job.name;
  const source = node("pre", job.source ? "Command: " + job.source : "Retained evaluation " + job.name.slice(0, 12));
  source.title = job.name;
  const output = node("div", undefined, "job-output");
  const values = node("pre", undefined, "returned-values");
  const status = node("span", "", "job-state");
  const operations = node("div", undefined, "command-row");
  const inputForm = node("div", undefined, "input-form");
  const input = node("textarea");
  input.rows = 1;
  input.spellcheck = false;
  input.setAttribute("aria-label", "Input for evaluation " + job.name.slice(0, 12));
  const view = {element, source, output, values, status, operations, inputForm, input, text: "", end: 0, info: null};
  inputForm.append(node("label", "Input:"), input,
    button("Send Input", () => sendInput(state.jobs[job.name], view, false)),
    button("EOF", () => sendInput(state.jobs[job.name], view, true)));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      run(() => sendInput(state.jobs[job.name], view, false));
    }
  });
  element.append(source, output, values, status, operations, inputForm);
  $("transcript").append(element);
  views.set(job.name, view);
  return view;
}
function updateJob(job, info, output) {
  const pending = state.pending.find(record => record.operation === "start-listener"
    && record.arguments.name === job.name);
  if (pending) {
    job.source = pending.arguments.source;
    job.clearBefore = pending.clearBefore;
    job.clearState = pending.clearState;
  }
  const view = views.get(job.name) || createView(job);
  view.info = info;
  view.source.textContent = job.source ? "Command: " + job.source : "Retained evaluation " + job.name.slice(0, 12);
  view.source.title = job.name;
  if (output.start !== view.end || output.end < output.start || output.end > info["output-length"]
      || Array.from(output.text).length !== output.end - output.start) {
    throw new Error("Invalid retained output range.");
  }
  view.text += output.text;
  view.end = output.end;
  view.element.hidden = Boolean(job.hidden);
  renderOutput(view, info["listener-result"]?.presentations, info["output-length"]);
  view.values.textContent = info.state === ":returned" && info["listener-result"]?.kind !== ":command"
    ? ((info.values || []).length ? info.values.join("\n") : "(No values)") : "";
  view.status.textContent = label(info.state) + (info["input-waiting-p"] ? " — awaiting input" : "")
    + (info["current-boot-p"] ? "" : " — accepted before this boot")
    + (view.end < info["output-length"] ? " — receiving output (" + view.end + " of "
      + info["output-length"] + " characters)" : "");
  view.inputForm.hidden = info.state !== ":running" || info["input-mode"] !== ":interactive" || info["input-eof-p"];
  const operationsSignature = JSON.stringify([job.token, info.stops, info.state === ":running", Boolean(info["interruptible-p"])]);
  if (view.operationsSignature === operationsSignature) return;
  view.operationsSignature = operationsSignature;
  view.operations.replaceChildren();
  for (const stop of info.stops || []) {
    view.operations.append(button("Debugger", () => selectStop(stop), "Mouse-Left: Select this evaluation's debugger stop."));
  }
  if (info.state === ":running") {
    const interrupt = button("Interrupt", async () => {
      const current = await api("job-information", {job: job.token});
      const id = current["next-interrupt-id"];
      await mutate("interrupt-job", {job: job.token, id});
      message("Interrupt request " + id + " accepted.");
      await refresh();
    }, "Mouse-Left: Request a retained debugger stop.");
    interrupt.disabled = !info["interruptible-p"];
    view.operations.append(interrupt);
  } else {
    view.operations.append(button("Release", async () => {
      await mutate("release-job", {job: job.token});
      await refresh();
    }, "Mouse-Left: Release this completed evaluation and its output."));
  }
}
async function refresh() {
  if (!connected) return;
  const offsets = [...views.entries()].map(([name, view]) => ({name, start: view.end}));
  const sample = await api("monitor-state", {offsets});
  const editor = $("source");
  const priorDraft = editorDraftKeys.get(editor);
  const editorBounds = editor.getBoundingClientRect();
  const pageBounds = $("page").getBoundingClientRect();
  const editorVisible = document.activeElement === editor
    && editorBounds.top >= pageBounds.top && editorBounds.bottom <= pageBounds.bottom;
  const listenerInfo = sample.listener;
  activeListenerJob = listenerInfo["active-job"] ?? null;
  listenerDebugger = listenerInfo.debugger || null;
  listenerPrompt = listenerInfo.prompt;
  updateListenerInput();
  if (state.initialHerald?.session !== state.session) state.initialHerald = {session: state.session, hidden: false};
  if ($("herald").dataset.session !== state.session && listenerInfo.herald) {
    $("herald").replaceChildren(renderHerald(listenerInfo.herald));
    $("herald").dataset.session = state.session;
  }
  state.package = listenerInfo.package;
  $("listener-prompt").textContent = listenerDebugger?.prompt || listenerInfo.prompt;
  $("package").textContent = listenerInfo.package;
  const names = new Set();
  for (const record of sample.jobs || []) {
    const info = record.information;
    names.add(info.name);
    const job = state.jobs[info.name] || {name: info.name, source: ""};
    job.token = record.token;
    state.jobs[info.name] = job;
    updateJob(job, info, record.output);
  }
  for (const [name, job] of Object.entries(state.jobs)) {
    if (!names.has(name)) removeJob(job.token);
  }
  stops = (sample.stops || []).map(record => ({token: record.token, info: record.information}));
  for (const record of sample.jobs || []) {
    const job = state.jobs[record.information.name];
    if (job) applyListenerEffects(job, record.information);
  }
  for (const [name, view] of views) view.element.hidden = Boolean(state.jobs[name]?.hidden);
  state.commands = state.commands.filter(command => stops.some(stop => same(stop.token, command.stop)));
  if (selectedStop && !stops.some(stop => same(stop.token, selectedStop))) {
    selectedStop = null;
  }
  for (const command of state.commands) {
    const key = commandKey(command);
    const prior = commandResults.get(key);
    if (!prior || prior.state === ":pending" || prior.state === ":running") {
      commandResults.set(key, await api("result", {stop: command.stop, id: command.id}));
    }
  }
  save();
  $("herald").hidden = !$("herald").firstElementChild || Boolean(state.initialHerald?.hidden);
  placeHeraldOnPixels();
  renderJobs();
  renderInputHistory();
  await inspectSelectedStop();
  renderStops();
  renderListenerState();
  renderPending();
  updateStatus();
  updateTracks();
  if (activity === "listener" && document.activeElement === editor
      && (editorVisible || priorDraft !== editorDraftKeys.get(editor))) {
    editor.scrollIntoView({block: "nearest"});
  }
}
function renderListenerState() {
  const panel = $("listener-state");
  const info = views.get(activeListenerJob)?.info;
  panel.hidden = !info;
  if (!info) return;
  const stop = listenerDebugger?.stop || info.stops?.[0];
  let status = panel.querySelector("span");
  if (!status) { status = node("span"); panel.append(status); }
  status.textContent = stop
    ? "This Listener is stopped in the debugger. "
    : info["input-waiting-p"] ? "This Listener is waiting for evaluation input. "
      : "This Listener is evaluating. ";
  let action = panel.querySelector("button");
  if (stop) {
    if (!action) { action = button("Debugger", () => selectStop(stop)); panel.append(action); }
    action.onclick = () => run(() => selectStop(stop));
  } else action?.remove();
}
function stopCommandPending(stop) {
  return state.pending.some(record => record.operation === "submit" && record.status !== "rejected"
      && same(record.arguments.stop, stop))
    || state.commands.some(command => {
      if (!same(command.stop, stop)) return false;
      const result = commandResults.get(commandKey(command));
      return !result || result.state === ":pending" || result.state === ":running";
    });
}
async function inspectSelectedStop() {
  const selected = stops.find(stop => same(stop.token, selectedStop));
  if (!(activity === "debugger" || (activity === "listener" && listenerDebugger))
      || !selected || selected.info.state !== ":stopped"
      || selected.info.child || stopCommandPending(selectedStop)) return;
  let command = ["frames", "restarts", "condition"].find(name => !latestCommand(name));
  const frameCommand = state.commands.findLast(item => same(item.stop, selectedStop) && frameCommands.includes(item.command));
  if (!command && !frameCommand) command = "current-frame";
  if (command) await mutate("submit", {stop: selectedStop,
    id: selected.info["next-command-id"], command, argument: null});
}
function renderJobs() {
  $("jobs").replaceChildren();
  for (const job of Object.values(state.jobs)) {
    const view = views.get(job.name);
    const row = node("div", undefined, "job-row");
    row.append(button((job.receipt ? "Command result " : "") + job.name.slice(0, 12) + "  " + label(view?.info?.state), () => {
      job.hidden = false;
      if (view) view.element.hidden = false;
      save();
      showActivity("listener");
      view?.element.scrollIntoView({block: "nearest"});
    }));
    row.append(node("pre", job.source || "Source is unavailable in this tab."));
    $("jobs").append(row);
  }
  if (!Object.keys(state.jobs).length) $("jobs").textContent = "No retained evaluations.";
}
function commandKey(command) {
  return JSON.stringify([command.stop, command.id]);
}
async function submit(stop, command, argument = null, metadata = {}) {
  const info = await api("information", {stop});
  const id = info["next-command-id"];
  await mutate("submit", {stop, id, command, argument}, metadata);
  await refresh();
}
async function selectStop(stop) {
  activateStop(stop);
  showActivity("debugger");
  await refresh();
  $("debugger-command").focus();
}
function latestCommand(commandName) {
  return state.commands.findLast(command => same(command.stop, selectedStop) && command.command === commandName);
}
function returnedInspection(commandName) {
  const command = state.commands.findLast(item => same(item.stop, selectedStop)
    && item.command === commandName && commandResults.get(commandKey(item))?.state === ":returned");
  return command ? {command, result: commandResults.get(commandKey(command)).result} : null;
}
function returnedFrameInspection() {
  const command = state.commands.findLast(item => same(item.stop, selectedStop)
    && frameCommands.includes(item.command) && commandResults.get(commandKey(item))?.state === ":returned");
  const result = command && commandResults.get(commandKey(command)).result;
  const info = stops.find(stop => same(stop.token, selectedStop))?.info;
  return result && (info?.state === ":closed" || result.index === info?.["current-frame"]) ? {command, result} : null;
}
function returnedResult(commandName) {
  return returnedInspection(commandName)?.result ?? null;
}
function returnedInspections(stop = selectedStop) {
  const commands = state.commands.filter(command => same(command.stop, stop));
  const cleared = commands.findLast(command => command.command === "clear-inspection"
    && commandResults.get(commandKey(command))?.state === ":returned");
  return commands.filter(command => (!cleared || command.id > cleared.id)
    && ["inspect", "modify"].includes(command.command)
    && commandResults.get(commandKey(command))?.state === ":returned")
    .map(command => ({command, result: commandResults.get(commandKey(command)).result}));
}
function inspectionRange(result) {
  return result.start === result.end ? "No components on this page (" + result.total + " total)"
    : "Components " + result.start + "–" + (result.end - 1) + " of " + result.total;
}
function renderInspector(stop, info, available, control, controls) {
  const records = returnedInspections(stop);
  if (!records.length && !state.commands.some(command => same(command.stop, stop)
      && command.command === "clear-inspection"
      && commandResults.get(commandKey(command))?.state === ":returned")) return null;
  const prefix = JSON.stringify(stop) + ":inspector:";
  function element(key, tag, className) {
    key = prefix + key;
    const result = stopControls.get(key) || node(tag, undefined, className);
    controls.set(key, result);
    return result;
  }
  function action(key, title, command, argument, help) {
    const result = control(prefix + key, title, () => submit(stop, command, argument), help);
    result.disabled = !available;
    return result;
  }
  const panel = element("panel", "section", "inspector");
  panel.setAttribute("aria-label", "Object Inspector");
  const header = element("header", "div", "inspector-header");
  const history = element("history", "div", "inspector-history");
  history.setAttribute("aria-label", "Inspector history");
  const entries = records.map(({command, result}) => action("history:" + command.id,
    inspectionRange(result) + ": " + result.title, "inspect", [result.object, result.start, result.count],
    "Mouse-Left: Inspect this object and recorded component range again."));
  reconcileChildren(history, [node("h3", "History"), ...entries]);
  const menu = element("menu", "div", "inspector-menu");
  reconcileChildren(menu, [
    action("inspect", "Inspect Last", "inspect", null, "Mouse-Left: Inspect the primary evaluation-history value."),
    action("describe", "Describe Last", "describe-object", null, "Mouse-Left: Describe the primary evaluation-history value."),
    action("clear", "Clear", "clear-inspection", null, "Mouse-Left: Release Inspector references and clear its displayed history.")
  ]);
  reconcileChildren(header, [history, menu]);
  const children = [node("h3", info.state === ":closed" ? "Inspector: recorded objects from this closed stop" : "Inspector"), header];
  if (!records.length) children.push(node("p", "No retained Inspector objects."));
  for (const {command, result} of records.slice(-3)) {
    const key = "page:" + command.id;
    const pane = element(key, "section", "inspection-pane");
    pane.dataset.commandId = command.id;
    pane.setAttribute("aria-label", "Inspection " + command.id);
    const toolbar = element(key + ":toolbar", "div", "inspection-toolbar");
    const previous = action(key + ":previous", "More Above", "inspect",
      [result.object, Math.max(0, result.start - result.count), result.count],
      "Mouse-Left: Inspect the preceding component page.");
    previous.disabled ||= result.start === 0;
    const next = action(key + ":next", "More Below", "inspect",
      [result.object, result.end, result.count], "Mouse-Left: Inspect the following component page.");
    next.disabled ||= result.end >= result.total;
    reconcileChildren(toolbar, [
      action(key + ":refresh", "Refresh", "inspect", [result.object, result.start, result.count],
        "Mouse-Left: Read this object and component range again."),
      action(key + ":describe", "Describe", "describe-object", result.object,
        "Mouse-Left: Describe this retained object."), previous, next,
      node("span", inspectionRange(result))
    ]);
    const table = element(key + ":parts", "table", "inspection-parts");
    table.setAttribute("aria-label", "Object components");
    const rows = (result.parts || []).map((part, index) => {
      const partKey = key + ":part:" + index;
      const row = element(partKey, "tr");
      const value = element(partKey + ":value", "td");
      reconcileChildren(value, part["bound-p"] && part.object != null
        ? [action(partKey + ":inspect", part.value, "inspect", [part.object, 0, result.count],
          "Mouse-Left: Inspect this component value.")]
        : [node("span", part["bound-p"] ? part.value : "<unbound>")]);
      const modify = element(partKey + ":modify", "td");
      reconcileChildren(modify, part.part == null ? [] : [action(partKey + ":write", "Modify", "modify",
        [part.part, result.start, result.count], "Mouse-Left: Read a Lisp expression for this component's new value.")]);
      reconcileChildren(row, [node("th", part.label), value, modify]);
      return row;
    });
    reconcileChildren(table, rows);
    const contents = element(key + ":contents", "div", "inspection-contents");
    reconcileChildren(contents, [table]);
    reconcileChildren(pane, [node("pre", result.title, "inspection-title"), node("pre", result.type), toolbar, contents]);
    children.push(pane);
  }
  reconcileChildren(panel, children);
  return panel;
}
function debuggerAction(action) {
  return async () => {
    await action();
    (activity === "listener" ? $("source") : $("debugger-command")).focus();
  };
}
async function debuggerCommand(text, stop = selectedStop) {
  const selected = stops.find(item => same(item.token, stop));
  if (!selected) throw new Error("Select a debugger stop first.");
  const plan = await api("listener-assistance", {source: text, cursor: Array.from(text).length,
    action: "parse", context: "debugger"});
  if (plan.error) throw new Error(plan.error);
  if (!plan["complete-p"]) throw new Error(plan.prompt || "Complete the debugger command.");
  if (typeof plan.operation !== "string") throw new Error("No executable debugger operation was returned.");
  await submit(stop, plan.operation, plan.argument ?? null,
    {display: plan.display, localIndex: plan["local-index"], source: text});
}
function queueDebuggerInput(editor, text, stop) {
  const key = editorDraftKeys.get(editor);
  return run(async () => {
    await debuggerCommand(text, stop);
    if (editorDraftKeys.get(editor) === key && editor.value === text) {
      setEditor(editor, "", 0);
      clearAssistance(editor);
    } else if (state.drafts[key]?.text === text) {
      state.drafts[key] = {...state.drafts[key], text: "", start: 0, end: 0};
      save();
    }
  });
}
function queueDebuggerCommand() {
  return queueDebuggerInput($("debugger-command"), $("debugger-command").value, selectedStop);
}
function reconcileChildren(parent, children) {
  const retained = new Set(children);
  for (const child of [...parent.childNodes]) if (!retained.has(child)) child.remove();
  let next = parent.firstChild;
  for (const child of children) {
    if (child !== next) parent.insertBefore(child, next);
    next = child.nextSibling;
  }
}
function renderStops() {
  const selected = stops.find(stop => same(stop.token, selectedStop));
  const controls = new Map();
  const prefix = JSON.stringify(selectedStop) + ":";
  function control(key, text, action, help) {
    const element = stopControls.get(key) || button(text, action, help);
    if (element.textContent !== text) element.textContent = text;
    element.onclick = () => {
      if (element.closest("#debugger-menu")) $("system-menu").close();
      return run(action);
    };
    if (help) element.dataset.help = help;
    controls.set(key, element);
    return element;
  }
  const menu = $("debugger-menu");
  const menuChildren = [node("h3", "This Debugger")];
  const list = $("stops");
  const listChildren = [];
  list.hidden = Boolean(selected);
  $("debugger-heading").hidden = Boolean(selected);
  for (const stop of stops) {
    const select = control("stop:" + JSON.stringify(stop.token), "Stop " + stop.info.id + "  " + shortIdentity(stop.info.thread) + "  " + label(stop.info.state),
      debuggerAction(() => selectStop(stop.token)), "Mouse-Left: Select this stop.");
    select.title = stop.info.thread;
    if (selected) menuChildren.push(select);
    else listChildren.push(select);
  }
  if (!stops.length) listChildren.push(document.createTextNode("No retained debugger stops."));
  reconcileChildren(list, listChildren);
  const detail = $("stop-detail");
  const detailChildren = [];
  $("debug-command").hidden = !selected;
  if (!selected) {
    reconcileChildren(menu, menuChildren);
    reconcileChildren(detail, detailChildren);
    stopControls = controls;
    $("listener-debugger").hidden = true;
    if (activity === "debugger") {
      $("window-label").textContent = "Debugger";
      $("window-label").title = "";
    }
    return;
  }
  const inline = activity === "listener" && listenerDebugger && same(selectedStop, listenerDebugger.stop);
  $("listener-debugger").hidden = !inline;
  if (inline) {
    if (detail.parentElement !== $("listener-debugger")) $("listener-debugger").append(detail);
  } else if (detail.parentElement !== $("debugger")) {
    $("debugger").insertBefore(detail, $("debugger-assistance"));
  }
  $("debug-command").hidden = inline;
  if (!inline) useEditorDraft($("debugger-command"), debuggerDraftKey(selectedStop));
  const info = selected.info;
  $("debugger-prompt").textContent = info.prompt || "→";
  const available = info.state === ":stopped" && !info.child && !stopCommandPending(selectedStop);
  $("debugger-command").disabled = info.state !== ":stopped";
  if (activity === "debugger") {
    $("window-label").textContent = "Lisp Debugger: Stop " + info.id + "  " + label(info.state);
    $("window-label").title = info.thread;
  }
  if (info.parent) detailChildren.push(control(prefix + "parent:" + JSON.stringify(info.parent), "Parent Stop", debuggerAction(() => selectStop(info.parent))));
  if (info.child) detailChildren.push(control(prefix + "child:" + JSON.stringify(info.child), "Child Stop", debuggerAction(() => selectStop(info.child))));
  if (info.state === ":closed") {
    menuChildren.push(control(prefix + "release", "Release Stop", debuggerAction(async () => {
      await mutate("release-stop", {stop: selectedStop});
      await refresh();
    })));
  } else {
    const inspect = control(prefix + "condition", "Inspect Condition", debuggerAction(() => submit(selectedStop, "condition")));
    inspect.disabled = !available;
    menuChildren.push(inspect);
    for (const name of [":Show Backtrace", ":Show Proceed Options", ":Show Frame", ":Show Local All",
                        ":Next Frame", ":Previous Frame", ":Top Of Stack", ":Bottom Of Stack",
                        ":Inspect", ":Describe Last", ":Clear Inspector"]) {
      const command = control(prefix + name, name, debuggerAction(() => debuggerCommand(name)));
      command.disabled = !available;
      menuChildren.push(command);
    }
  }
  const help = returnedResult("help");
  if (help !== null) detailChildren.push(node("pre", help, "debugger-help"));
  const condition = returnedResult("condition");
  if (condition !== null) detailChildren.push(node("pre", condition, "condition"));
  const inspector = renderInspector(selectedStop, info, available, control, controls);
  if (inspector) detailChildren.push(inspector);
  const frameInspection = returnedFrameInspection();
  if (frameInspection) {
    const {command: request, result: frame} = frameInspection;
    if (info.state === ":closed") detailChildren.push(node("pre", "Recorded frame " + frame.index + " from this closed stop.", "recorded-frame"));
    detailChildren.push(node("pre", frame.function, "current-function"));
    const locals = frame.locals || [];
    if (request.display === ":frame") {
      detailChildren.push(node("pre", "Original caller arguments are unavailable. Available lexical locals follow."));
    }
    const visibleLocals = request.localIndex == null ? locals : locals.filter(local => local.index === request.localIndex);
    if (!visibleLocals.length) detailChildren.push(node("pre", request.localIndex == null
      ? "No local values are recorded for this frame." : "No local value with the requested index."));
    const table = node("table", undefined, "locals");
    table.setAttribute("aria-label", "Frame locals");
    table.title = "Frame " + frame.index + ": " + frame.function;
    for (const local of visibleLocals) {
      const row = node("tr");
      row.append(node("td", "Local " + local.index + " (" + local.name + "):"),
                 node("td", local["available-p"] ? local.value : "<unavailable>"));
      table.append(row);
    }
    detailChildren.push(table);
  } else if (info["current-frame"] != null) {
    detailChildren.push(node("pre", "Frame " + info["current-frame"] + " selected. Use :Show Frame to inspect its locals."));
  }
  const restarts = returnedResult("restarts");
  if (restarts) {
    const panel = stopControls.get(prefix + "restarts") || node("div", undefined, "restarts");
    controls.set(prefix + "restarts", panel);
    const proceed = control(prefix + "proceed", ":Proceed", () => submit(selectedStop, "proceed"),
      "Mouse-Left: Invoke the default CONTINUE restart and request any interactive arguments.");
    proceed.disabled = !available;
    const restartChildren = [proceed];
    for (const restart of restarts) {
      const action = control(prefix + "restart:" + restart.index,
        restart.name + ": [" + restart.index + (restart["default-p"] ? ", Default" : "") + "] " + restart.description,
        () => submit(selectedStop, "invoke-restart-interactively", restart.index),
        "Mouse-Left: Invoke this restart and request any interactive arguments.");
      action.disabled = !available;
      restartChildren.push(action);
      const argumentsAction = control(prefix + "restart-arguments:" + restart.index,
        ":Proceed " + restart.index + " :Arguments",
        () => submit(selectedStop, "invoke-restart-with-arguments", restart.index),
        "Mouse-Left: Read a Lisp expression whose value is the argument list for this restart.");
      argumentsAction.disabled = !available;
      restartChildren.push(argumentsAction);
    }
    reconcileChildren(panel, restartChildren);
    detailChildren.push(panel);
  }
  const restartCommand = state.commands.findLast(command => same(command.stop, selectedStop)
    && ["proceed", "invoke-restart", "invoke-restart-interactively", "invoke-restart-with-arguments", "abort"].includes(command.command));
  const restartResult = restartCommand && commandResults.get(commandKey(restartCommand));
  if (restartResult?.state === ":returned") {
    const values = restartResult.result || [];
    detailChildren.push(node("pre", "Restart returned:\n" + (values.length ? values.join("\n") : "(No values)"), "restart-values"));
  }
  const frames = returnedResult("frames");
  if (frames) {
    detailChildren.push(node("pre", "→ :Show Backtrace", "debugger-transcript"));
    for (const [index, frame] of frames.entries()) {
      const item = control(prefix + "frame:" + index, index + "  " + frame.function, () => debuggerCommand(":Set Current Frame " + index),
        "Mouse-Left: Select this frame and show its locals.");
      item.className = "frame" + (index === info["current-frame"] ? " selected" : "");
      item.disabled = !available;
      detailChildren.push(item);
    }
  }
  for (const command of state.commands.filter(item => same(item.stop, selectedStop))) {
    const result = commandResults.get(commandKey(command));
    if (command.command === "evaluate") {
      const evaluation = node("div", undefined, "debugger-evaluation");
      evaluation.append(node("pre", "→ " + (command.source ?? command.argument), "debugger-transcript"));
      const values = result?.result || [];
      evaluation.append(node("pre", result?.state === ":returned"
        ? (values.length ? values.join("\n") : "(No values)") : label(result?.state), "evaluation-values"));
      detailChildren.push(evaluation);
    } else if (command.command === "describe-object") {
      const description = node("div", undefined, "debugger-description");
      description.append(node("pre", "→ " + (command.source ?? "Describe"), "debugger-transcript"),
        node("pre", result?.state === ":returned" ? result.result : label(result?.state), "description-result"));
      detailChildren.push(description);
    } else if (!result || result.state === ":pending" || result.state === ":running") {
      detailChildren.push(node("p", command.command + ": " + label(result?.state)));
    }
  }
  reconcileChildren(menu, menuChildren);
  reconcileChildren(detail, detailChildren);
  stopControls = controls;
}
function renderPending() {
  $("requests").querySelector("h2").textContent = "Request History";
  $("pending").replaceChildren();
  for (const record of state.pending) {
    const row = node("div", undefined, "command-row");
    row.append(node("pre", record.operation + ": " + record.status + (record.error ? "\n" + record.error : "")));
    if (["start-evaluation", "start-listener", "save-private-document", "job-input", "interrupt-job", "submit"].includes(record.operation)) {
      row.append(button("Repeat Original Request", async () => {
        await replay(record);
        await refresh();
      }, "Mouse-Left: Repeat the saved request with its original name, range, or ID."));
    }
    if (["release-job", "release-stop", "release-session"].includes(record.operation)
        && record.status !== "rejected") {
      row.append(button("Check Release Outcome", () => reconcileRelease(record),
        "Mouse-Left: Query the original reference without repeating the release."));
    }
    if (record.status === "rejected" || record.status.startsWith("retained at last check")) {
      row.append(button("Keep in History", async () => archive(record)));
    }
    row.append(node("pre", JSON.stringify(record.arguments)));
    $("pending").append(row);
  }
  if (!state.pending.length) $("pending").append(node("p", "Every current submission has a reply."));
  for (const command of state.commands) {
    const result = commandResults.get(commandKey(command));
    const row = node("div", undefined, "command-row");
    row.append(node("pre", "Stop token " + command.stop[2] + ", command " + command.id + " "
      + command.command + ": " + label(result?.state)
      + (result && !result["current-boot-p"] ? " (earlier boot)" : "")));
    row.append(node("pre", JSON.stringify(command)));
    $("pending").append(row);
  }
  for (const history of state.history) {
    $("pending").append(node("pre", "Recorded session " + history.session + "\n"
      + JSON.stringify(history, null, 2)));
  }
}
function updateStatus() {
  $("package-label").textContent = "CL " + state.package + ":";
  if (selectingActivity) $("process-state").textContent = "Select:";
  else if (!connected) $("process-state").textContent = "Disconnected";
  else if ((activity === "debugger" && stops.some(stop => same(stop.token, selectedStop) && stop.info.state === ":stopped"))
      || views.get(activeListenerJob)?.info.stops?.length) $("process-state").textContent = "Debugger";
  else if (activeListenerJob && !views.get(activeListenerJob)?.info["input-waiting-p"]) $("process-state").textContent = "Run";
  else $("process-state").textContent = "User Input";
  for (const element of $("who-line").children) placeTextOnPixels(element);
}
function openMenu() {
  if (!$("system-menu").open) $("system-menu").showModal();
  placeDialogOnPixels($("system-menu"));
}
function updateTracks() {
  const page = $("page");
  const vertical = $("vertical-track").firstElementChild;
  const horizontal = $("horizontal-track").firstElementChild;
  horizontal.style.width = (Math.min(1, page.clientWidth / Math.max(1, page.scrollWidth)) * 100) + "%";
  horizontal.style.marginLeft = ((page.scrollLeft / Math.max(1, page.scrollWidth)) * $("horizontal-track").clientWidth) + "px";
  const fraction = Math.min(1, page.clientHeight / Math.max(1, page.scrollHeight));
  vertical.style.height = (fraction * 100) + "%";
  vertical.style.marginTop = ((page.scrollTop / Math.max(1, page.scrollHeight)) * $("vertical-track").clientHeight) + "px";
}
function cancelActivitySelection() {
  selectingActivity = false;
  updateStatus();
}
document.addEventListener("keydown", event => {
  if (event.key === "F9" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    selectingActivity = true;
    updateStatus();
    return;
  }
  if (!selectingActivity) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
  cancelActivitySelection();
  if (["Backspace", "Delete", "Escape"].includes(event.key)) return;
  if (event.key === "F12") {
    selectHelpFocus = document.activeElement;
    $("select-help").showModal();
    placeDialogOnPixels($("select-help"));
    return;
  }
  const name = {l: "listener", d: "examiner", p: "peek"}[event.key.toLowerCase()];
  if (name && $(name)) {
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    showActivity(name);
  } else message("No activity is assigned to SELECT " + event.key + ". F9 then F12 lists activities.");
}, true);
document.addEventListener("pointerdown", () => { if (selectingActivity) cancelActivitySelection(); });
window.addEventListener("blur", () => { if (selectingActivity) cancelActivitySelection(); });
$("select-help").addEventListener("close", () => selectHelpFocus?.focus());
$("select-help").addEventListener("keydown", event => {
  if (event.key === "F11" && event.shiftKey) { event.preventDefault(); $("select-help").close(); }
});
$("close-select-help").onclick = () => $("select-help").close();
document.addEventListener("contextmenu", event => {
  event.preventDefault();
  openMenu();
});
function defaultMouseHelp() {
  return activity === "peek" ? $("peek").dataset.help
    : "Mouse-Right: System Menu. Return: Execute input. Tab: Complete. F12: Help.";
}
document.addEventListener("pointerover", event => {
  const help = event.target.closest("[data-help]");
  $("mouse-help").textContent = help?.dataset.help || defaultMouseHelp();
});
document.addEventListener("focusin", event => {
  const help = event.target.closest("[data-help]");
  $("mouse-help").textContent = help?.dataset.help || defaultMouseHelp();
});
$("window-label").onclick = openMenu;
$("package-label").onclick = openMenu;
$("close-menu").onclick = () => $("system-menu").close();
document.querySelectorAll("[data-activity]").forEach(element => {
  element.onclick = () => showActivity(element.dataset.activity);
});
$("evaluate").onsubmit = event => { event.preventDefault(); queueEvaluation(); };
for (const id of ["source", "debugger-command"]) {
  const editor = $(id);
  editor.onkeydown = event => editorKey(editor, event);
  editor.oninput = event => editorChanged(editor, event);
  editor.onclick = () => { storeEditorDraft(editor); scheduleAssistance(editor, "inspect"); };
  editor.onkeyup = () => storeEditorDraft(editor);
  editor.onselect = () => storeEditorDraft(editor);
}
$("debug-command").onsubmit = event => { event.preventDefault(); queueDebuggerCommand(); };
$("evaluate-button").onclick = () => { $("system-menu").close(); queueEvaluation(); };
$("clear-input").onclick = () => { setEditor($("source"), "", 0); clearAssistance($("source")); showActivity("listener"); };
$("set-package").onclick = () => {
  setEditor($("source"), "Set Package ", 12);
  showActivity("listener");
  scheduleAssistance($("source"), "inspect");
};
$("refresh").onclick = () => { $("system-menu").close(); run(refresh); };
$("resume-session").onclick = () => { $("system-menu").close(); run(connect); };
$("new-session").onclick = () => run(newSession);
$("release-session").onclick = () => run(async () => {
  if (state.pending.length) throw new Error("Resolve the recorded requests before releasing the session.");
  await mutate("release-session", {});
  $("system-menu").close();
  message("Session released. Guest evaluations remain retained.");
});
$("package").textContent = state.package;
$("interactive").checked = state.interactive;
$("interactive").onchange = () => run(async () => { state.interactive = $("interactive").checked; save(); });
$("page").onscroll = updateTracks;
$("vertical-track").onclick = event => {
  const track = $("vertical-track");
  const ratio = (event.clientY - track.getBoundingClientRect().top) / track.clientHeight;
  $("page").scrollTop = ratio * ($("page").scrollHeight - $("page").clientHeight);
};
$("horizontal-track").onclick = event => {
  const track = $("horizontal-track");
  const ratio = (event.clientX - track.getBoundingClientRect().left) / track.clientWidth;
  $("page").scrollLeft = ratio * ($("page").scrollWidth - $("page").clientWidth);
};
window.addEventListener("resize", updateTracks);
function placeHeraldOnPixels() {
  document.fonts.ready.then(() => {
    for (const herald of document.querySelectorAll(".herald")) {
      if (!herald.getClientRects().length || !herald.clientWidth) continue;
      herald.style.left = "0px";
      herald.style.left = (Math.round(herald.getBoundingClientRect().left) - herald.getBoundingClientRect().left) + "px";
      for (const element of herald.querySelectorAll(".herald-title, .herald-facts > p")) placeTextOnPixels(element);
      const tables = herald.querySelector(".herald-systems");
      if (tables) {
        tables.style.left = "0px";
        tables.style.left = (Math.round(tables.getBoundingClientRect().left) - tables.getBoundingClientRect().left) + "px";
        const first = Math.floor(Math.max(0, tables.clientWidth - 8) * 322 / 696);
        tables.style.gridTemplateColumns = first + "px minmax(0, 1fr)";
      }
      for (const key of herald.querySelectorAll(".herald-key")) {
        const width = key.offsetWidth;
        key.querySelector("svg").setAttribute("viewBox", "0 0 " + width + " 9");
        key.querySelector("path").setAttribute("d", "M0.5 4.5L4.5 0.5H" + (width - 4.5) + "L" + (width - 0.5)
          + " 4.5L" + (width - 4.5) + " 8.5H4.5Z");
      }
    }
  }).catch(report);
}
placeHeraldOnPixels();
window.addEventListener("resize", placeHeraldOnPixels);
document.addEventListener("activitychange", placeHeraldOnPixels);
window.addEventListener("resize", () => {
  for (const element of $("who-line").children) placeTextOnPixels(element);
  for (const dialog of document.querySelectorAll("dialog[open]")) placeDialogOnPixels(dialog);
});
setInterval(() => {
  $("clock").textContent = new Date().toLocaleString("en-GB", {weekday: "short", day: "2-digit",
    month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  for (const element of $("who-line").children) placeTextOnPixels(element);
}, 1000);
setInterval(() => { if (connected && !busy) run(refresh); }, 1500);
if (storageError) report(storageError);
else run(connect);
