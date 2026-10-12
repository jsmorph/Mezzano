"use strict";

const $ = id => document.getElementById(id);
const storageKey = "mezzano-monitor-v1";
const defaultState = {session: null, attempted: false, jobs: {}, pending: [], commands: [],
                      package: "CL-USER", interactive: false, history: [], inputHistory: [], nextInputSequence: 0};
let state = defaultState;
let storageError = null;
try {
  const saved = sessionStorage.getItem(storageKey);
  if (saved) state = {...defaultState, ...JSON.parse(saved)};
} catch (error) {
  storageError = error;
}
for (const [index, item] of state.inputHistory.entries()) {
  if (!Number.isSafeInteger(item.sequence)) item.sequence = index;
  state.nextInputSequence = Math.max(state.nextInputSequence, item.sequence + 1);
}
let connected = false;
let busy = false;
let actions = Promise.resolve();
let activity = "listener";
let selectedStop = null;
let selectedFrame = null;
let stops = [];
let historyIndex = null;
const assistanceTimers = new Map();
const views = new Map();
const commandResults = new Map();

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
  message(error.message || String(error));
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
function applyMutation(record, result) {
  const args = record.arguments;
  if (["start-evaluation", "start-listener"].includes(record.operation)) {
    state.jobs[args.name] = {...state.jobs[args.name], name: args.name, source: args.source,
      token: result, listener: record.operation === "start-listener", clearBefore: record.clearBefore};
    if (record.operation === "start-listener"
        && !state.inputHistory.some(item => item.name === args.name)) {
      state.inputHistory.push({name: args.name, source: args.source,
        sequence: record.inputSequence ?? state.nextInputSequence++});
      state.inputHistory.sort((left, right) => left.sequence - right.sequence);
    }
  } else if (record.operation === "submit") {
    const command = {stop: args.stop, id: args.id, command: args.command, argument: args.argument,
      display: record.display, localIndex: record.localIndex};
    if (!state.commands.some(item => same(item.stop, command.stop) && item.id === command.id)) {
      state.commands.push(command);
    }
  } else if (record.operation === "release-job") {
    for (const [name, job] of Object.entries(state.jobs)) {
      if (same(job.token, args.job)) {
        delete state.jobs[name];
        views.get(name)?.element.remove();
        views.delete(name);
      }
    }
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
      if (error.reason === ":expired-session") connected = false;
      archive(record);
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
function showActivity(name) {
  activity = name;
  $("monitor").classList.toggle("examiner-active", name === "examiner");
  document.querySelectorAll(".activity").forEach(element => { element.hidden = element.id !== name; });
  const labels = {listener: "Dynamic Lisp Listener 1", debugger: "Debugger", evaluations: "Evaluations",
                  requests: "Request History", help: "Listener Help", "input-history": "Input History",
                  examiner: "Document Examiner"};
  $("window-label").textContent = labels[name];
  $("system-menu").close();
  if (name === "listener") $("source").focus();
  else if (name === "debugger" && selectedStop) $("debugger-command").focus();
  else if (name === "examiner") { $("examiner-command").focus(); run(() => examiner.show()); }
  else $("page").focus();
  updateTracks();
}
function queueEvaluation() {
  const source = $("source").value;
  const interactive = $("interactive").checked;
  return run(() => evaluate(source, interactive));
}
async function evaluate(source, interactive) {
  if (!source.trim()) return;
  state.interactive = interactive;
  const clearBefore = Object.values(state.jobs).filter(job => !job.hidden).map(job => job.name);
  await mutate("start-listener", {name: freshName(), source, interactive}, {clearBefore});
  if ($("source").value === source) setEditor($("source"), "", 0);
  historyIndex = null;
  showActivity("listener");
  await refresh();
  $("page").scrollTop = $("page").scrollHeight;
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
}
function editorContext(editor) {
  return editor.id === "source" ? "listener" : editor.id === "examiner-command" ? "examiner" : "debugger";
}
function clearAssistance(editor) {
  $(editorContext(editor) + "-assistance").replaceChildren();
}
function renderAssistance(editor, result, source, cursor, action) {
  const panel = $(editorContext(editor) + "-assistance");
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
  if (activity === editorContext(editor)) editor.scrollIntoView({block: "nearest"});
}
function scheduleAssistance(editor, action, presentation) {
  clearTimeout(assistanceTimers.get(editor));
  const source = editor.value;
  const cursor = editorCursor(editor);
  const request = () => run(async () => {
    if (!connected || editor.value !== source || editorCursor(editor) !== cursor) return;
    const context = editorContext(editor);
    const result = await api(context === "examiner" ? "document-assistance" : "listener-assistance", {
      source, cursor, action, ...(context === "examiner" ? {} : {context}),
      ...(presentation === undefined ? {} : {presentation})});
    if (editor.value !== source || editorCursor(editor) !== cursor) return;
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
  clearAssistance(editor);
  if (editor.id === "source") { historyIndex = null; resizeSource(); }
  scheduleAssistance(editor, event.inputType === "insertText" && event.data === " " ? "space" : "inspect");
}
function renderOutput(view, presentations) {
  const signature = JSON.stringify([view.text, presentations]);
  if (signature === view.outputSignature) return;
  const chars = Array.from(view.text);
  const pieces = [];
  let offset = 0;
  for (const presentation of presentations || []) {
    if (presentation.type !== ":pathname" || !Number.isInteger(presentation.start)
        || !Number.isInteger(presentation.end) || presentation.start < offset
        || presentation.end < presentation.start || presentation.end > chars.length
        || typeof presentation.value !== "string") {
      throw new Error("Invalid pathname presentation in Listener output.");
    }
    pieces.push(document.createTextNode(chars.slice(offset, presentation.start).join("")));
    const pathname = button(chars.slice(presentation.start, presentation.end).join(""), async () => {
      showActivity("listener");
      scheduleAssistance($("source"), "insert", presentation.value);
    }, "Mouse-Left: Insert this pathname into the current command argument.");
    pathname.className = "presentation";
    pathname.title = presentation.value;
    pieces.push(pathname);
    offset = presentation.end;
  }
  pieces.push(document.createTextNode(chars.slice(offset).join("")));
  view.output.replaceChildren(...pieces);
  view.outputSignature = signature;
}
function applyListenerEffects(job, info) {
  const result = info["listener-result"];
  if (![":returned", ":aborted", ":unwound"].includes(info.state)
      || !job.listener || job.effectsApplied || !result) return;
  for (const effect of result.effects || []) {
    if (effect.operation === ":clear-output-history") {
      for (const name of job.clearBefore || []) {
        if (state.jobs[name]) state.jobs[name].hidden = true;
        if (views.has(name)) views.get(name).element.hidden = true;
      }
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
  const output = node("pre");
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
async function updateJob(job, info) {
  const view = views.get(job.name) || createView(job);
  view.info = info;
  view.source.textContent = job.source ? "Command: " + job.source : "Retained evaluation " + job.name.slice(0, 12);
  view.source.title = job.name;
  if (info["output-length"] < view.end) {
    view.end = 0;
    view.text = "";
  }
  if (info["output-length"] > view.end) {
    const output = await api("job-output", {job: job.token, start: view.end});
    view.text += output.text;
    view.end = output.end;
  }
  applyListenerEffects(job, info);
  view.element.hidden = Boolean(job.hidden);
  renderOutput(view, info["listener-result"]?.presentations);
  view.values.textContent = info.state === ":returned" && info["listener-result"]?.kind !== ":command"
    ? ((info.values || []).length ? info.values.join("\n") : "(No values)") : "";
  view.status.textContent = label(info.state) + (info["input-waiting-p"] ? " — awaiting input" : "")
    + (info["current-boot-p"] ? "" : " — accepted before this boot");
  view.inputForm.hidden = info.state !== ":running" || info["input-mode"] !== ":interactive" || info["input-eof-p"];
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
    interrupt.disabled = info["interrupt-id"] !== null;
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
  const listenerInfo = await api("listener-information");
  state.package = listenerInfo.package;
  $("listener-prompt").textContent = listenerInfo.prompt;
  $("package").textContent = listenerInfo.package;
  const tokens = await api("jobs") || [];
  const names = new Set();
  for (const token of tokens) {
    const info = await api("job-information", {job: token});
    names.add(info.name);
    const job = state.jobs[info.name] || {name: info.name, source: ""};
    job.token = token;
    state.jobs[info.name] = job;
    await updateJob(job, info);
  }
  for (const [name, job] of Object.entries(state.jobs)) {
    if (job.token && !names.has(name)) {
      delete state.jobs[name];
      views.get(name)?.element.remove();
      views.delete(name);
    }
  }
  const stopTokens = await api("stops", {include_closed: true}) || [];
  stops = [];
  for (const token of stopTokens) {
    stops.push({token, info: await api("information", {stop: token})});
  }
  state.commands = state.commands.filter(command => stops.some(stop => same(stop.token, command.stop)));
  if (selectedStop && !stops.some(stop => same(stop.token, selectedStop))) {
    selectedStop = null;
    selectedFrame = null;
  }
  for (const command of state.commands) {
    const key = commandKey(command);
    const prior = commandResults.get(key);
    if (!prior || prior.state === ":pending" || prior.state === ":running") {
      commandResults.set(key, await api("result", {stop: command.stop, id: command.id}));
    }
  }
  save();
  $("herald").hidden = Object.keys(state.jobs).length > 0;
  renderJobs();
  renderInputHistory();
  renderStops();
  renderPending();
  updateStatus();
  updateTracks();
}
function renderJobs() {
  $("jobs").replaceChildren();
  for (const job of Object.values(state.jobs)) {
    const view = views.get(job.name);
    const row = node("div", undefined, "job-row");
    row.append(button(job.name.slice(0, 12) + "  " + label(view?.info?.state), () => {
      job.hidden = false;
      if (view) view.element.hidden = false;
      save();
      showActivity("listener");
      view?.element.scrollIntoView({block: "nearest"});
    }));
    row.append(node("pre", job.source || "Source belongs to another client."));
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
  selectedStop = stop;
  selectedFrame = null;
  showActivity("debugger");
  await refresh();
}
function latestCommand(commandName) {
  return state.commands.findLast(command => same(command.stop, selectedStop) && command.command === commandName);
}
function returnedResult(commandName) {
  const command = latestCommand(commandName);
  const record = command && commandResults.get(commandKey(command));
  return record?.state === ":returned" ? record.result : null;
}
function debuggerAction(action) {
  return async () => {
    $("system-menu").close();
    await action();
    $("debugger-command").focus();
  };
}
async function debuggerCommand(text) {
  const selected = stops.find(stop => same(stop.token, selectedStop));
  if (!selected) throw new Error("Select a debugger stop first.");
  const plan = await api("listener-assistance", {source: text, cursor: Array.from(text).length,
    action: "parse", context: "debugger"});
  if (plan.error) throw new Error(plan.error);
  if (!plan["complete-p"]) throw new Error(plan.prompt || "Complete the debugger command.");
  if (plan["select-frame"] != null) {
    const index = plan["select-frame"];
    const frame = returnedResult("frames")?.[index];
    if (!frame) throw new Error(":Show Backtrace, then select an existing frame number.");
    selectedFrame = {token: frame.frame, index, function: frame.function};
  }
  if (typeof plan.operation !== "string") throw new Error("No executable debugger operation was returned.");
  if (plan["needs-frame"] && !selectedFrame) {
    throw new Error(":Show Backtrace, then select a frame.");
  }
  await submit(selectedStop, plan.operation, plan["needs-frame"] ? selectedFrame.token : null,
    {display: plan.display, localIndex: plan["local-index"]});
}
function queueDebuggerCommand() {
  const text = $("debugger-command").value;
  run(async () => {
    await debuggerCommand(text);
    if ($("debugger-command").value === text) setEditor($("debugger-command"), "", 0);
    clearAssistance($("debugger-command"));
  });
}
function renderStops() {
  const selected = stops.find(stop => same(stop.token, selectedStop));
  const menu = $("debugger-menu");
  menu.replaceChildren(node("h3", "This Debugger"));
  const list = $("stops");
  list.replaceChildren();
  list.hidden = Boolean(selected);
  $("debugger-heading").hidden = Boolean(selected);
  for (const stop of stops) {
    const select = button("Stop " + stop.info.id + "  " + shortIdentity(stop.info.thread) + "  " + label(stop.info.state),
      debuggerAction(() => selectStop(stop.token)), "Mouse-Left: Select this stop.");
    select.title = stop.info.thread;
    if (selected) menu.append(select);
    else list.append(select);
  }
  if (!stops.length) list.textContent = "No retained debugger stops.";
  $("stop-detail").replaceChildren();
  $("debug-command").hidden = !selected;
  if (!selected) return;
  const detail = $("stop-detail");
  const info = selected.info;
  $("debugger-command").disabled = info.state !== ":stopped";
  if (activity === "debugger") {
    $("window-label").textContent = "Lisp Debugger: Stop " + info.id + "  " + label(info.state);
    $("window-label").title = info.thread;
  }
  if (info.parent) detail.append(button("Parent Stop", debuggerAction(() => selectStop(info.parent))));
  if (info.child) detail.append(button("Child Stop", debuggerAction(() => selectStop(info.child))));
  if (info.state === ":closed") {
    menu.append(button("Release Stop", debuggerAction(async () => {
      await mutate("release-stop", {stop: selectedStop});
      await refresh();
    })));
  } else {
    menu.append(button("Inspect Condition", debuggerAction(() => submit(selectedStop, "condition"))));
    for (const name of [":Show Backtrace", ":Show Proceed Options", ":Show Frame", ":Show Local All"]) {
      menu.append(button(name, debuggerAction(() => debuggerCommand(name))));
    }
  }
  const condition = returnedResult("condition");
  if (condition !== null) detail.append(node("pre", condition, "condition"));
  if (selectedFrame) detail.append(node("pre", selectedFrame.function, "current-function"));
  const locals = returnedResult("locals");
  if (locals && selectedFrame && same(latestCommand("locals")?.argument, selectedFrame.token)) {
    const request = latestCommand("locals");
    if (request.display === ":frame") {
      detail.append(node("pre", "Original caller arguments are unavailable. Available lexical locals follow."));
    }
    const visibleLocals = request.localIndex == null ? locals : locals.filter(local => local.index === request.localIndex);
    if (!visibleLocals.length) detail.append(node("pre", "No local value with the requested index."));
    const table = node("table", undefined, "locals");
    table.setAttribute("aria-label", "Frame locals");
    table.title = "Frame " + selectedFrame.index + ": " + selectedFrame.function;
    for (const local of visibleLocals) {
      const row = node("tr");
      row.append(node("td", "Local " + local.index + " (" + local.name + "):"),
                 node("td", local["available-p"] ? local.value : "<unavailable>"));
      table.append(row);
    }
    detail.append(table);
  }
  const restarts = returnedResult("restarts");
  if (restarts) {
    const panel = node("div", undefined, "restarts");
    for (const restart of restarts) {
      const action = button(restart.name + ": " + restart.description,
        () => submit(selectedStop, "invoke-restart", restart.index),
        "Mouse-Left: Invoke this restart with zero arguments.");
      action.disabled = info.state !== ":stopped";
      panel.append(action);
    }
    detail.append(panel);
  }
  const frames = returnedResult("frames");
  if (frames) {
    detail.append(node("pre", "→ :Show Backtrace", "debugger-transcript"));
    for (const [index, frame] of frames.entries()) {
      const item = button(index + "  " + frame.function, () => debuggerCommand(":Set Current Frame " + index),
        "Mouse-Left: Select this frame and show its locals.");
      item.className = "frame" + (same(frame.frame, selectedFrame?.token) ? " selected" : "");
      item.disabled = info.state !== ":stopped";
      detail.append(item);
    }
  }
  for (const command of state.commands.filter(item => same(item.stop, selectedStop))) {
    const result = commandResults.get(commandKey(command));
    if (!result || result.state === ":pending" || result.state === ":running") {
      detail.append(node("p", command.command + ": " + label(result?.state)));
    }
  }
}
function renderPending() {
  $("requests").querySelector("h2").textContent = "Request History";
  $("pending").replaceChildren();
  for (const record of state.pending) {
    const row = node("div", undefined, "command-row");
    row.append(node("pre", record.operation + ": " + record.status + (record.error ? "\n" + record.error : "")));
    if (["start-evaluation", "start-listener", "job-input", "interrupt-job", "submit"].includes(record.operation)) {
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
  if (!connected) $("process-state").textContent = "Disconnected";
  else if (busy) $("process-state").textContent = "Run";
  else if (stops.some(stop => stop.info.state === ":stopped")) $("process-state").textContent = "Debugger";
  else if ([...views.values()].some(view => view.info?.state === ":running" && !view.info["input-waiting-p"])) {
    $("process-state").textContent = "Run";
  } else $("process-state").textContent = "User Input";
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
document.addEventListener("contextmenu", event => {
  event.preventDefault();
  openMenu();
});
document.addEventListener("pointerover", event => {
  const help = event.target.closest("[data-help]");
  $("mouse-help").textContent = help?.dataset.help || "Mouse-Right: System Menu. Return: Execute input. Tab: Complete. F12: Help.";
});
document.addEventListener("focusin", event => {
  const help = event.target.closest("[data-help]");
  if (help) $("mouse-help").textContent = help.dataset.help;
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
  editor.onclick = () => scheduleAssistance(editor, "inspect");
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
$("new-session").onclick = () => run(async () => {
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
});
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
    for (const element of document.querySelectorAll("#herald h1, #herald p > span")) placeTextOnPixels(element);
  }).catch(report);
}
placeHeraldOnPixels();
window.addEventListener("resize", placeHeraldOnPixels);
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
