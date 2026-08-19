async function loadMeters() {
  const meters = await (await fetch("/api/meters")).json();
  const body = document.getElementById("meterTableBody");

  if (!meters.length) {
    body.innerHTML = '<tr><td colspan="3">No meters yet - add one below.</td></tr>';
    return;
  }

  const rows = await Promise.all(meters.map(async (m) => {
    const last = await (await fetch(`/api/meters/${m.id}/last`)).json();
    let lastText = "-";
    if (last.error) lastText = "Error: " + last.error;
    else if (last.value !== null && last.value !== undefined) lastText = `${last.value} (${last.timestamp || ""})`;
    return `<tr>
      <td><a href="/meter/${m.id}">${escapeHtml(m.name)}</a></td>
      <td>${escapeHtml(String(lastText))}</td>
      <td><button onclick="removeMeter('${m.id}', '${escapeHtml(m.name)}')">Delete</button></td>
    </tr>`;
  }));
  body.innerHTML = rows.join("");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function addMeter() {
  const nameEl = document.getElementById("newMeterName");
  const name = nameEl.value.trim();
  if (!name) return alert("Enter a name first");

  const res = await fetch("/api/meters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const j = await res.json();
  if (j.error) return alert(j.error);

  nameEl.value = "";
  window.location.href = `/meter/${j.id}`;
}

async function removeMeter(id, name) {
  if (!confirm(`Delete meter "${name}"? This removes its reference image, ROIs and history permanently.`)) return;
  await fetch(`/api/meters/${id}`, { method: "DELETE" });
  loadMeters();
}

async function loadModels() {
  const models = await (await fetch("/api/models")).json();
  const body = document.getElementById("modelTableBody");
  if (!models.length) {
    body.innerHTML = '<tr><td colspan="2">No models uploaded yet.</td></tr>';
    return;
  }
  body.innerHTML = models.map((m) => `<tr>
    <td>${escapeHtml(m)}</td>
    <td><button onclick="removeModel('${m}')">Delete</button></td>
  </tr>`).join("");
}

async function uploadModel() {
  const f = document.getElementById("modelFile").files[0];
  if (!f) return alert("Choose a .tflite file first");
  const fd = new FormData();
  fd.append("file", f);
  const res = await fetch("/api/models", { method: "POST", body: fd });
  const j = await res.json();
  document.getElementById("modelStatus").textContent = j.error
    ? j.error
    : `Loaded ${j.filename} — input shape ${JSON.stringify(j.input_shape)} (${j.input_dtype}), output shape ${JSON.stringify(j.output_shape)}`;
  loadModels();
}

async function removeModel(filename) {
  if (!confirm(`Delete model "${filename}"? Any meter still assigned to it will fail to process new images.`)) return;
  await fetch(`/api/models/${encodeURIComponent(filename)}`, { method: "DELETE" });
  loadModels();
}

window.onload = () => {
  loadMeters();
  loadModels();
};
