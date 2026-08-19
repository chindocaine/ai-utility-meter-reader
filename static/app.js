const METER_ID = document.body.dataset.meterId;
const API = `/api/meters/${METER_ID}`;

let rois = [];
let img = new Image();
let canvas = document.getElementById("canvas");
let ctx = canvas.getContext("2d");
let drawing = false;
let startX = 0, startY = 0;
let scale = 1; // canvas display scale relative to native image pixels

function loadReferenceIntoCanvas() {
  img = new Image();
  img.onload = () => {
    const maxW = 860;
    scale = img.width > maxW ? maxW / img.width : 1;
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    redraw();
  };
  img.src = `${API}/reference?ts=` + Date.now();
}

function drawGrid(context, w, h, spacing = 40) {
  context.save();
  context.strokeStyle = "rgba(230, 57, 70, 0.5)";
  context.lineWidth = 1;
  for (let x = spacing; x < w; x += spacing) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, h);
    context.stroke();
  }
  for (let y = spacing; y < h; y += spacing) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(w, y);
    context.stroke();
  }
  context.restore();
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (document.getElementById("gridRoi").checked) {
    drawGrid(ctx, canvas.width, canvas.height);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#2f6fed";
  ctx.font = "14px monospace";
  ctx.fillStyle = "#2f6fed";
  rois.forEach((r, i) => {
    ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    ctx.fillText(i, r.x * scale + 2, r.y * scale - 4);
  });
  document.getElementById("roiCount").textContent = rois.length + " digit box(es)";
}

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
  drawing = true;
});

canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  const curY = e.clientY - rect.top;
  redraw();
  ctx.strokeStyle = "#e63946";
  ctx.strokeRect(startX, startY, curX - startX, curY - startY);
});

canvas.addEventListener("mouseup", (e) => {
  if (!drawing) return;
  drawing = false;
  const rect = canvas.getBoundingClientRect();
  const curX = e.clientX - rect.left;
  const curY = e.clientY - rect.top;
  const x = Math.min(startX, curX) / scale;
  const y = Math.min(startY, curY) / scale;
  const w = Math.abs(curX - startX) / scale;
  const h = Math.abs(curY - startY) / scale;
  if (w > 3 && h > 3) {
    rois.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }
  redraw();
});

function undoRoi() { rois.pop(); redraw(); }
function clearRois() { rois = []; redraw(); }

async function saveMeterName() {
  const name = document.getElementById("meterName").value.trim();
  if (!name) return alert("Name can't be empty");
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  document.getElementById("meterTitle").textContent = name;
  document.title = name + " - Utility Meter Reader";
}

async function deleteMeter() {
  const name = document.getElementById("meterName").value || "this meter";
  if (!confirm(`Delete "${name}"? This removes its reference image, ROIs and history permanently.`)) return;
  await fetch(`/api/meters/${METER_ID}`, { method: "DELETE" });
  window.location.href = "/";
}

async function uploadReference() {
  const f = document.getElementById("refFile").files[0];
  if (!f) return alert("Choose a file first");
  const fd = new FormData();
  fd.append("file", f);
  const res = await fetch(`${API}/reference`, { method: "POST", body: fd });
  const j = await res.json();
  document.getElementById("refStatus").textContent = j.ok ? "Uploaded." : JSON.stringify(j);
  loadReferenceIntoCanvas();
  loadRotatePreview();
}

// --- Reference image rotation preview (client-side only until "Apply") ---

let rotateRefImg = new Image();
let pendingRotationDeg = 0;
const rotateCanvas = document.getElementById("rotateCanvas");
const rotateCtx = rotateCanvas.getContext("2d");

function loadRotatePreview() {
  rotateRefImg = new Image();
  rotateRefImg.onload = () => {
    pendingRotationDeg = 0;
    document.getElementById("rotationValue").textContent = "0°";
    drawRotatePreview();
  };
  rotateRefImg.src = `${API}/reference?ts=` + Date.now();
}

function drawRotatePreview() {
  if (!rotateRefImg.width) return;
  const maxW = 860;
  const scale = rotateRefImg.width > maxW ? maxW / rotateRefImg.width : 1;
  const w = rotateRefImg.width * scale;
  const h = rotateRefImg.height * scale;
  const rad = pendingRotationDeg * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const newW = Math.round(w * cos + h * sin);
  const newH = Math.round(w * sin + h * cos);
  rotateCanvas.width = newW;
  rotateCanvas.height = newH;

  rotateCtx.fillStyle = "#fff";
  rotateCtx.fillRect(0, 0, newW, newH);
  rotateCtx.save();
  rotateCtx.translate(newW / 2, newH / 2);
  rotateCtx.rotate(rad);
  rotateCtx.drawImage(rotateRefImg, -w / 2, -h / 2, w, h);
  rotateCtx.restore();

  if (document.getElementById("gridRotate").checked) {
    drawGrid(rotateCtx, newW, newH);
  }
}

function nudgeRotation(delta) {
  pendingRotationDeg += delta;
  if (pendingRotationDeg > 180) pendingRotationDeg -= 360;
  if (pendingRotationDeg < -180) pendingRotationDeg += 360;
  document.getElementById("rotationValue").textContent = pendingRotationDeg.toFixed(1) + "°";
  drawRotatePreview();
}

function resetRotationPreview() {
  pendingRotationDeg = 0;
  document.getElementById("rotationValue").textContent = "0°";
  drawRotatePreview();
}

async function applyRotation() {
  if (pendingRotationDeg === 0) return alert("Adjust the rotation first");
  if (rois.length && !confirm(
    "Applying this rotation will clear the existing ROI boxes, since their coordinates " +
    "would no longer line up. Continue?"
  )) return;

  const res = await fetch(`${API}/reference/rotate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Canvas rotate() treats positive as clockwise (Y axis points down);
    // cv2.getRotationMatrix2D treats positive as counter-clockwise - negate
    // so the backend actually rotates the same visual direction as the preview.
    body: JSON.stringify({ degrees: -pendingRotationDeg }),
  });
  const j = await res.json();
  if (j.error) return alert(j.error);

  rois = [];
  loadReferenceIntoCanvas();
  loadRotatePreview();
  alert("Rotation applied." + (j.cleared_rois ? " ROI boxes were cleared - redraw them below." : ""));
}

async function loadModelOptions(selected) {
  const models = await (await fetch("/api/models")).json();
  const select = document.getElementById("modelFile");
  if (!models.length) {
    select.innerHTML = '<option value="">(none uploaded yet)</option>';
    return;
  }
  select.innerHTML = models.map((m) => `<option value="${m}">${m}</option>`).join("");
  if (selected && models.includes(selected)) select.value = selected;
}

async function saveModelSelection() {
  const modelFile = document.getElementById("modelFile").value;
  if (!modelFile) return alert("Upload a model on the meter overview page first");
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_file: modelFile,
      num_classes: parseInt(document.getElementById("numClasses").value),
    }),
  });
  document.getElementById("modelStatus").textContent = "Saved.";
}

async function saveRois() {
  await fetch(`${API}/rois`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rois }),
  });
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      decimal_digits: parseInt(document.getElementById("decimalDigits").value || "0"),
    }),
  });
  alert("Saved " + rois.length + " ROIs.");
}

async function saveSettings() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      alignment_method: document.getElementById("alignMethod").value,
      min_match_count: parseInt(document.getElementById("minMatch").value),
    }),
  });
  alert("Saved alignment settings.");
}

async function saveEsp() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      esp_snapshot_url: document.getElementById("espUrl").value,
      poll_interval_seconds: parseInt(document.getElementById("pollInterval").value || "300"),
    }),
  });
  alert("Saved.");
}

async function saveRobustness() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      allow_digit_fallback: document.getElementById("allowDigitFallback").checked,
      reject_decreasing: document.getElementById("rejectDecreasing").checked,
      max_increase_per_reading: parseFloat(document.getElementById("maxIncrease").value || "0"),
    }),
  });
  alert("Saved.");
}

async function saveMqtt() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mqtt_host: document.getElementById("mqttHost").value,
      mqtt_port: parseInt(document.getElementById("mqttPort").value || "1883"),
      mqtt_topic: document.getElementById("mqttTopic").value,
      mqtt_username: document.getElementById("mqttUser").value,
      mqtt_password: document.getElementById("mqttPass").value,
    }),
  });
  alert("Saved.");
}

async function runTest() {
  const fd = new FormData();
  const f = document.getElementById("testFile").files[0];
  if (f) fd.append("file", f);
  const debug = document.getElementById("testDebug").checked;
  fd.append("debug", debug ? "true" : "false");

  const res = await fetch(`${API}/test`, { method: "POST", body: fd });
  const j = await res.json();
  const box = document.getElementById("testResult");
  const debugPanel = document.getElementById("testDebugPanel");
  if (j.error) {
    box.textContent = "Error: " + j.error;
    debugPanel.style.display = "none";
    return;
  }

  const valueText = j.value === null ? "unreadable" : j.value;
  box.textContent = `Value: ${valueText}  |  digits: ${j.digits.join("")}  |  raw: ${j.raw_values.join(", ")}  |  confidences: ${j.confidences.join(", ")}`;
  if (j.substituted_positions && j.substituted_positions.length) {
    box.textContent += `  |  carried over from last reading at position(s) ${j.substituted_positions.join(", ")} (marked * in the image)`;
  }
  if (j.invalid_positions && j.invalid_positions.length) {
    box.textContent += `  |  UNREADABLE at position(s) ${j.invalid_positions.join(", ")} - check alignment/ROIs`;
  }

  const imgEl = document.getElementById("testImage");
  imgEl.src = j.annotated_image;
  imgEl.style.display = "block";

  if (debug && j.debug) {
    debugPanel.innerHTML = j.debug.map((d, i) => {
      const thumb = j.crop_thumbnails[i]
        ? `<img src="${j.crop_thumbnails[i]}" style="height:60px;vertical-align:middle;margin-right:8px;">`
        : "";
      return `<div style="margin-bottom:6px;">${thumb}` +
        `digit ${i}: ${j.valid[i] ? "valid" : "UNREADABLE"} - output_len=${d.output_len}, ` +
        `top5 idx=${JSON.stringify(d.output_top5_idx)}, top5 val=${JSON.stringify(d.output_top5_val.map(v => v.toFixed(3)))}` +
        `</div>`;
    }).join("");
    debugPanel.style.display = "block";
  } else {
    debugPanel.style.display = "none";
  }
}

async function refreshStatus() {
  const cfg = await (await fetch(`${API}/config`)).json();
  const last = await (await fetch(`${API}/last`)).json();
  document.getElementById("statusBox").textContent =
    "Config:\n" + JSON.stringify(cfg, null, 2) + "\n\nLast reading:\n" + JSON.stringify(last, null, 2);

  document.getElementById("meterName").value = cfg.name;
  document.getElementById("meterTitle").textContent = cfg.name;
  document.title = cfg.name + " - Utility Meter Reader";
  document.getElementById("decimalDigits").value = cfg.decimal_digits;
  document.getElementById("numClasses").value = cfg.num_classes;
  await loadModelOptions(cfg.model_file);
  document.getElementById("alignMethod").value = cfg.alignment_method;
  document.getElementById("minMatch").value = cfg.min_match_count;
  document.getElementById("espUrl").value = cfg.esp_snapshot_url || "";
  document.getElementById("pollInterval").value = cfg.poll_interval_seconds;
  document.getElementById("allowDigitFallback").checked = !!cfg.allow_digit_fallback;
  document.getElementById("rejectDecreasing").checked = !!cfg.reject_decreasing;
  document.getElementById("maxIncrease").value = cfg.max_increase_per_reading || 0;
  document.getElementById("mqttHost").value = cfg.mqtt_host || "";
  document.getElementById("mqttPort").value = cfg.mqtt_port;
  document.getElementById("mqttTopic").value = cfg.mqtt_topic;
  document.getElementById("mqttUser").value = cfg.mqtt_username || "";
  rois = cfg.rois || [];
}

window.onload = async () => {
  // Fetch the saved config (incl. rois) before drawing the reference image,
  // so the ROI boxes are already known by the time the canvas first renders.
  await refreshStatus();
  loadReferenceIntoCanvas();
  loadRotatePreview();
};
