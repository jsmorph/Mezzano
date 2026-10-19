"use strict";

(() => {
  let mode = "help";
  let previousActivity = "listener";
  let interval = 20;
  let digits = "";
  let timer = null;
  let pending = false;
  let sample = null;
  let sampledAt = null;
  const visible = () => activity === "peek" && mode === "processes" && !document.hidden;

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    stopTimer();
    if (visible() && !pending) timer = setTimeout(() => refreshSample(true), interval * 1000);
  }
  function status(error) {
    const element = $("peek-sample-status");
    const stamp = sampledAt && sampledAt.toLocaleTimeString("en-GB", {hour12: false});
    element.classList.toggle("stale", Boolean(error));
    element.dataset.state = error ? "stale" : sample ? "sampled" : "empty";
    element.textContent = error
      ? (sample ? "Stale sample from " + stamp + ". " : "No sample. ") + error.message
      : sample ? sample.threads.length + " processes sampled at " + stamp + ". Update interval: " + interval + " seconds."
      : "No sample.";
  }
  function fields(row, units, stamp) {
    return "Name: " + row.name + "\nState: " + label(row.state) + "\nPriority: " + label(row.priority)
      + "\nWait kind: " + (row["wait-kind"] ? label(row["wait-kind"]) : "none")
      + "\nWait: " + (row.wait ?? "none")
      + "\nRecorded runtime: " + (row["run-time"] / units).toFixed(6) + " seconds"
      + "\nSample received: " + stamp.toLocaleTimeString("en-GB", {hour12: false})
      + "\nRuntime excludes an unfinished scheduling interval.";
  }
  function processMenu(row, units, stamp) {
    const description = fields(row, units, stamp);
    $("peek-process-title").textContent = "Operation on " + row.name + ":";
    const actions = $("peek-process-actions");
    actions.replaceChildren(button("Describe", () => {
      $("peek-process-menu").close();
      $("peek-description-fields").textContent = description;
      $("peek-description").showModal();
      placeDialogOnPixels($("peek-description"));
    }, "Mouse-Left: Display only the sampled process fields."));
    for (const stop of row.stops || []) {
      const action = button("Debugger: stop " + stop[2], async () => {
        if (stop[1] !== state.session) throw new Error("This debugger reference belongs to an earlier session. Refresh Processes.");
        $("peek-process-menu").close();
        await selectStop(stop);
      }, "Mouse-Left: Select this retained debugger stop.");
      action.disabled = stop[1] !== state.session;
      if (action.disabled) action.title = "Earlier session. Refresh Processes to acquire a current reference.";
      actions.append(action);
    }
    actions.append(button("Close", () => $("peek-process-menu").close()));
    $("peek-process-menu").showModal();
    placeDialogOnPixels($("peek-process-menu"));
  }
  function render() {
    const rows = $("process-rows");
    rows.replaceChildren();
    const stamp = sampledAt;
    const units = sample["run-time-units-per-second"];
    for (const row of sample.threads) {
      const line = node("tr");
      const name = node("td");
      const control = button(row.name, () => processMenu(row, units, stamp),
        "Mouse-Left: Process operations. Describe shows sampled fields; Debugger selects a retained stop.");
      control.className = "process-name";
      name.append(control);
      line.append(name, node("td", label(row.state)), node("td", label(row.priority)),
        node("td", row.wait ?? ""), node("td", (row["run-time"] / sample["run-time-units-per-second"]).toFixed(6)));
      rows.append(line);
    }
    status();
    updateTracks();
  }
  function refreshSample(background = false) {
    if (!visible() || pending) return;
    stopTimer();
    pending = true;
    return run(async () => {
      try {
        if (!visible()) return;
        if (!connected) throw new Error("Disconnected. Connect / Resume before refreshing.");
        const value = await api("processes");
        sample = value;
        sampledAt = new Date();
        render();
      } catch (error) {
        status(error);
        throw error;
      } finally {
        pending = false;
        schedule();
      }
    }, {background});
  }
  function setMode(next, background = false) {
    mode = next;
    digits = "";
    stopTimer();
    $("peek-help").hidden = mode !== "help";
    $("peek-processes").hidden = mode !== "processes";
    for (const item of document.querySelectorAll("[data-peek-mode]")) {
      item.setAttribute("aria-pressed", String(item.dataset.peekMode === mode));
    }
    if (activity === "peek") $("window-label").textContent = mode === "processes" ? "Processes" : "Peek Help";
    if (mode === "processes") refreshSample(background);
    $("page").focus();
    updateTracks();
  }
  function quit() { showActivity(previousActivity); }
  for (const item of document.querySelectorAll("[data-peek-mode]")) item.onclick = () => setMode(item.dataset.peekMode);
  $("peek-quit").onclick = quit;
  $("close-peek-description").onclick = () => $("peek-description").close();
  document.addEventListener("activitychange", event => {
    const {name, previous} = event.detail;
    $("monitor").classList.toggle("peek-active", name === "peek");
    $("peek-modes").hidden = name !== "peek";
    if (name === "peek") {
      if (previous !== "peek") previousActivity = previous;
      setMode(mode, true);
      $("mouse-help").textContent = $("peek").dataset.help;
    } else stopTimer();
  });
  document.addEventListener("visibilitychange", () => {
    stopTimer();
    if (visible()) refreshSample(true);
  });
  document.addEventListener("keydown", event => {
    if (activity !== "peek" || document.querySelector("dialog[open]") || event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (!(["p", "q", "z", " ", "f12", "backspace", "escape"].includes(key) || /^[0-9]$/.test(key))) return;
    event.preventDefault();
    if (/^[0-9]$/.test(key)) {
      digits += key;
      message(digits + " (Z: update interval in seconds)");
    } else if (key === "z") {
      const value = Number(digits);
      digits = "";
      if (!Number.isSafeInteger(value) || value < 1 || value > 86400) {
        message("Update interval must be an integer from 1 to 86400 seconds.");
      } else {
        interval = value;
        message("Peek update interval: " + interval + " seconds.");
        schedule();
        if (sample && $("peek-sample-status").dataset.state !== "stale") status();
      }
    } else if (key === "p") setMode("processes");
    else if (key === "f12") setMode("help");
    else if (key === "q") quit();
    else if (key === " ") refreshSample();
    else { digits = ""; message("Peek numeric argument cleared."); }
  });
})();
