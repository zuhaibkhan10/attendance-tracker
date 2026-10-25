// ---------- STATE ----------
let students = [];            // list from the server for the chosen date
let currentDate = todayString();
let searchText = "";
let editingId = null;         // which student is being renamed right now
let deletingId = null;        // which student the delete dialog is about

// ---------- SMALL HELPERS ----------
function todayString() {
  const d = new Date();      // local date, not UTC
  return dateToString(d);
}

function dateToString(d) {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + month + "-" + day;
}

function stringToDate(text) {
  const parts = text.split("-");
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// Turns < > & " ' into safe text, so a name can never run as code
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let toastTimer = null;
function showToast(message, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
}

// Talks to the server. Throws an error with the server's message if something fails.
async function api(url, method, body) {
  const options = { method: method || "GET", headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ---------- LOADING + DRAWING ----------
async function loadStudents() {
  try {
    students = await api("/students?date=" + currentDate);
    render();
  } catch (error) {
    showToast("Could not load students", true);
  }
}

function render() {
  renderHeader();
  renderStats();
  renderList();
}

function renderHeader() {
  const nice = stringToDate(currentDate).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
  const suffix = currentDate === todayString() ? "  (today)" : "";
  document.getElementById("dateLabel").textContent = nice + suffix;
  document.getElementById("dateInput").value = currentDate;
}

function renderStats() {
  const count = (status) => students.filter((s) => s.status === status).length;
  const present = count("present");
  const absent = count("absent");
  const late = count("late");
  const unmarked = students.length - present - absent - late;

  document.getElementById("statTotal").textContent = students.length;
  document.getElementById("statPresent").textContent = present;
  document.getElementById("statAbsent").textContent = absent;
  document.getElementById("statLate").textContent = late;
  document.getElementById("statUnmarked").textContent =
    students.length > 0 ? unmarked + " not marked" : "";
}

function renderList() {
  const list = document.getElementById("list");

  if (students.length === 0) {
    list.innerHTML = '<div class="card empty">No students yet. Add your first one above.</div>';
    return;
  }

  const query = searchText.trim().toLowerCase();
  const shown = students.filter((s) => s.name.toLowerCase().includes(query));

  if (shown.length === 0) {
    list.innerHTML = '<div class="card empty">No student matches "' + esc(searchText) + '"</div>';
    return;
  }

  list.innerHTML = shown.map(studentHtml).join("");

  // if a rename box is open, put the cursor in it
  const editBox = document.getElementById("editInput");
  if (editBox) { editBox.focus(); editBox.select(); }
}

function studentHtml(s) {
  const initial = s.name ? esc(s.name.charAt(0).toUpperCase()) : "?";

  // name area: either the normal name or the rename box
  let nameArea;
  if (editingId === s.id) {
    nameArea =
      '<div class="edit-row">' +
        '<input id="editInput" value="' + esc(s.name) + '" maxlength="50" aria-label="Student name">' +
        '<button class="btn primary" data-action="save">Save</button>' +
        '<button class="btn" data-action="cancel">Cancel</button>' +
      '</div>';
  } else {
    nameArea = s.name
      ? '<div class="name">' + esc(s.name) + '</div>'
      : '<div class="name blank">(no name)</div>';
  }

  // attendance percentage bar
  let barColor = "low";
  if (s.percent !== null && s.percent >= 75) barColor = "good";
  else if (s.percent !== null && s.percent >= 50) barColor = "mid";
  const width = s.percent === null ? 0 : s.percent;
  const pctText = s.percent === null
    ? "No records yet"
    : s.percent + "% attendance · " + s.days + (s.days === 1 ? " day" : " days");

  const chip = (status, label) =>
    '<button class="chip ' + status + (s.status === status ? " active" : "") + '"' +
    ' data-action="mark" data-status="' + status + '" aria-pressed="' + (s.status === status) + '">' +
    label + '</button>';

  return (
    '<div class="student" data-id="' + s.id + '">' +
      '<div class="avatar">' + initial + '</div>' +
      '<div class="info">' + nameArea +
        '<div class="bar-row">' +
          '<div class="bar"><div class="fill ' + barColor + '" style="width:' + width + '%"></div></div>' +
          '<span class="pct">' + pctText + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="tools">' +
        '<button class="icon-btn" data-action="edit" aria-label="Rename student" title="Rename">' +
          '<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
        '<button class="icon-btn danger" data-action="delete" aria-label="Delete student" title="Delete">' +
          '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>' +
      '</div>' +
      '<div class="chips">' +
        chip("present", "Present") + chip("absent", "Absent") + chip("late", "Late") +
      '</div>' +
    '</div>'
  );
}

// ---------- ACTIONS ----------
async function addStudent() {
  const input = document.getElementById("nameInput");
  const name = input.value.trim();
  if (!name) { showToast("Type a name first", true); return; }
  try {
    await api("/add_student", "POST", { name: name });
    input.value = "";
    showToast("Student added");
    await loadStudents();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function markStudent(id, status) {
  const student = students.find((s) => s.id === id);
  if (!student) return;
  // clicking the active button again clears the mark
  const newStatus = student.status === status ? null : status;
  try {
    await api("/mark", "POST", { student_id: id, date: currentDate, status: newStatus });
    await loadStudents();   // reload so the percentage updates too
  } catch (error) {
    showToast(error.message, true);
    loadStudents();
  }
}

async function saveRename(id) {
  const name = document.getElementById("editInput").value.trim();
  if (!name) { showToast("Name cannot be empty", true); return; }
  try {
    await api("/students/" + id, "PUT", { name: name });
    editingId = null;
    showToast("Name updated");
    await loadStudents();
  } catch (error) {
    showToast(error.message, true);
  }
}

function askDelete(id) {
  const student = students.find((s) => s.id === id);
  if (!student) return;
  deletingId = id;
  document.getElementById("confirmText").textContent =
    (student.name || "This student") + " and all their attendance records will be removed. This cannot be undone.";
  document.getElementById("confirmDialog").showModal();
}

async function confirmDelete() {
  document.getElementById("confirmDialog").close();
  try {
    await api("/students/" + deletingId, "DELETE");
    showToast("Student deleted");
    await loadStudents();
  } catch (error) {
    showToast(error.message, true);
  }
  deletingId = null;
}

function changeDay(amount) {
  const d = stringToDate(currentDate);
  d.setDate(d.getDate() + amount);
  setDate(dateToString(d));
}

function setDate(text) {
  if (!text) return;   // happens if the date box is cleared
  currentDate = text;
  editingId = null;
  loadStudents();
}

// ---------- CONNECT BUTTONS ----------
document.getElementById("addBtn").addEventListener("click", addStudent);
document.getElementById("nameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addStudent();
});

document.getElementById("searchInput").addEventListener("input", (e) => {
  searchText = e.target.value;
  renderList();
});

document.getElementById("dateInput").addEventListener("change", (e) => setDate(e.target.value));
document.getElementById("prevDay").addEventListener("click", () => changeDay(-1));
document.getElementById("nextDay").addEventListener("click", () => changeDay(1));
document.getElementById("todayBtn").addEventListener("click", () => setDate(todayString()));

document.getElementById("cancelDelete").addEventListener("click", () => {
  document.getElementById("confirmDialog").close();
});
document.getElementById("confirmDelete").addEventListener("click", confirmDelete);

document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch (e) {}
});

// One listener for all buttons inside the list (they are re-drawn often)
document.getElementById("list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const id = Number(button.closest(".student").dataset.id);
  const action = button.dataset.action;

  if (action === "mark") markStudent(id, button.dataset.status);
  else if (action === "edit") { editingId = id; renderList(); }
  else if (action === "cancel") { editingId = null; renderList(); }
  else if (action === "save") saveRename(id);
  else if (action === "delete") askDelete(id);
});

// Enter / Escape inside the rename box
document.getElementById("list").addEventListener("keydown", (e) => {
  if (e.target.id !== "editInput") return;
  if (e.key === "Enter") saveRename(editingId);
  if (e.key === "Escape") { editingId = null; renderList(); }
});

loadStudents();
