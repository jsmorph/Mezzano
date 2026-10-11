"use strict";

const $ = id => document.getElementById(id);
const storageKey = "mezzano-monitor-v1";
const defaultState = {session: null, attempted: false, jobs: {}, pending: [], commands: [],
                      package: "CL-USER", interactive: false, history: []};
let state = defaultState;
let storageError = null;
try {
  const saved = sessionStorage.getItem(storageKey);
  if (saved) state = {...defaultState, ...JSON.parse(saved)};
} catch (error) {
  storageError = error;
}
let connected = false;
let busy = false;
let actions = Promise.resolve();
let activity = "listener";
let selectedStop = null;
let selectedFrame = null;
let stops = [];
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
  if (record.operation === "start-evaluation") {
    state.jobs[args.name] = {name: args.name, source: args.source, token: result};
  } else if (record.operation === "submit") {
    const command = {stop: args.stop, id: args.id, command: args.command, argument: args.argument};
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
async function mutate(operation, arguments_) {
  if (!connected) throw new Error("Connect or resume the session first.");
  const record = {id: freshName(), session: state.session, operation, arguments: arguments_, status: "awaiting reply"};
  state.pending.push(record);
  save();
  return replay(record);
}
function showActivity(name) {
  activity = name;
  document.querySelectorAll(".activity").forEach(element => { element.hidden = element.id !== name; });
  const labels = {listener: "Dynamic Lisp Listener 1", debugger: "Debugger", evaluations: "Evaluations",
                  requests: "Request History", help: "Listener Help"};
  $("window-label").textContent = labels[name];
  $("system-menu").close();
  if (name === "listener") $("source").focus();
  else if (name === "debugger" && selectedStop) $("debugger-command").focus();
  else $("page").focus();
  updateTracks();
}
function queueEvaluation() {
  const source = $("source").value;
  const packageName = $("package").value.trim();
  const interactive = $("interactive").checked;
  return run(() => evaluate(source, packageName, interactive));
}
async function evaluate(source, packageName, interactive) {
  if (!source.trim()) return;
  state.package = packageName;
  state.interactive = interactive;
  save();
  await mutate("start-evaluation", {name: freshName(), source, package: state.package,
                                    interactive: state.interactive});
  if ($("source").value === source) $("source").value = "";
  resizeSource();
  showActivity("listener");
  await refresh();
  $("page").scrollTop = $("page").scrollHeight;
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
  const source = node("pre", job.source ? "Command: " + job.source : "Retained evaluation " + job.name.slice(0, 12));
  source.title = job.name;
  const output = node("pre");
  const values = node("pre");
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
  view.output.textContent = view.text;
  view.values.textContent = info.state === ":returned"
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
async function submit(stop, command, argument = null) {
  const info = await api("information", {stop});
  const id = info["next-command-id"];
  await mutate("submit", {stop, id, command, argument});
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
  const command = text.trim().toLowerCase();
  const selected = stops.find(stop => same(stop.token, selectedStop));
  if (!selected) throw new Error("Select a debugger stop first.");
  const operations = {"show condition": "condition", "show restarts": "restarts", "show stack": "frames"};
  if (operations[command]) await submit(selectedStop, operations[command]);
  else if (command === "parent stop" && selected.info.parent) await selectStop(selected.info.parent);
  else if (command === "child stop" && selected.info.child) await selectStop(selected.info.child);
  else if (/^frame [0-9]+$/.test(command)) {
    const index = Number(command.slice(6));
    const frame = returnedResult("frames")?.[index];
    if (!frame) throw new Error("Show Stack, then select an existing frame number.");
    selectedFrame = {token: frame.frame, index, function: frame.function};
    await submit(selectedStop, "locals", frame.frame);
  } else throw new Error("Commands: Show Condition, Show Restarts, Show Stack, Frame N, Parent Stop, Child Stop.");
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
    for (const name of ["Show Condition", "Show Restarts", "Show Stack"]) {
      menu.append(button(name, debuggerAction(() => debuggerCommand(name))));
    }
  }
  const condition = returnedResult("condition");
  if (condition !== null) detail.append(node("pre", condition, "condition"));
  if (selectedFrame) detail.append(node("pre", selectedFrame.function, "current-function"));
  const locals = returnedResult("locals");
  if (locals && selectedFrame && same(latestCommand("locals")?.argument, selectedFrame.token)) {
    const table = node("table", undefined, "locals");
    table.setAttribute("aria-label", "Frame locals");
    table.title = "Frame " + selectedFrame.index + ": " + selectedFrame.function;
    for (const local of locals) {
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
    detail.append(node("pre", "→ Show Stack", "debugger-transcript"));
    for (const [index, frame] of frames.entries()) {
      const item = button(index + "  " + frame.function, () => debuggerCommand("Frame " + index),
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
    if (["start-evaluation", "job-input", "interrupt-job", "submit"].includes(record.operation)) {
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
}
function openMenu() {
  if (!$("system-menu").open) $("system-menu").showModal();
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
  $("mouse-help").textContent = help?.dataset.help || "Mouse-Right: System Menu. Return: Evaluate Lisp.";
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
$("source").onkeydown = event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    queueEvaluation();
  }
};
$("debug-command").onsubmit = event => {
  event.preventDefault();
  const text = $("debugger-command").value;
  run(async () => {
    await debuggerCommand(text);
    $("debugger-command").value = "";
  });
};
$("source").oninput = resizeSource;
$("evaluate-button").onclick = () => { $("system-menu").close(); queueEvaluation(); };
$("clear-input").onclick = () => { $("source").value = ""; resizeSource(); showActivity("listener"); };
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
$("package").value = state.package;
$("interactive").checked = state.interactive;
$("package").onchange = () => run(async () => { state.package = $("package").value.trim(); save(); updateStatus(); });
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
setInterval(() => {
  $("clock").textContent = new Date().toLocaleString("en-GB", {weekday: "short", day: "2-digit",
    month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
}, 1000);
setInterval(() => { if (connected && !busy) run(refresh); }, 1500);
if (storageError) report(storageError);
else run(connect);
