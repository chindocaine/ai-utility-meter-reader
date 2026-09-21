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
  loadPerspectivePreview();
  loadQualityPreview();
}

async function grabReferenceFromSnapshot() {
  const status = document.getElementById("refStatus");
  status.textContent = "Grabbing...";
  const res = await fetch(`${API}/reference/from-snapshot`, { method: "POST" });
  const j = await res.json();
  status.textContent = j.ok ? "Grabbed from snapshot URL." : "Error: " + j.error;
  if (j.ok) {
    loadReferenceIntoCanvas();
    loadRotatePreview();
    loadPerspectivePreview();
    loadQualityPreview();
  }
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
  loadPerspectivePreview();
  loadQualityPreview();
  alert("Rotation applied." + (j.cleared_rois ? " ROI boxes were cleared - redraw them below." : ""));
}

// --- Image quality preview (brightness/contrast/sharpness, applied at processing time) ---

let qualityRefImg = new Image();
const qualityCanvas = document.getElementById("qualityCanvas");
const qualityCtx = qualityCanvas.getContext("2d");

function loadQualityPreview() {
  qualityRefImg = new Image();
  qualityRefImg.onload = () => drawQualityPreview();
  qualityRefImg.src = `${API}/reference?ts=` + Date.now();
}

function drawQualityPreview() {
  const brightness = parseFloat(document.getElementById("qualityBrightness").value);
  const contrast = parseFloat(document.getElementById("qualityContrast").value);
  const sharpness = parseFloat(document.getElementById("qualitySharpness").value);
  document.getElementById("qualityBrightnessVal").textContent = brightness;
  document.getElementById("qualityContrastVal").textContent = contrast.toFixed(1);
  document.getElementById("qualitySharpnessVal").textContent = sharpness.toFixed(1);

  if (!qualityRefImg.width) return;
  const maxW = 860;
  const scale = qualityRefImg.width > maxW ? maxW / qualityRefImg.width : 1;
  const w = Math.round(qualityRefImg.width * scale);
  const h = Math.round(qualityRefImg.height * scale);
  qualityCanvas.width = w;
  qualityCanvas.height = h;

  // Approximates the backend's cv2 convertScaleAbs(alpha=contrast, beta=brightness) -
  // exact enough to guide slider choice, not meant to match pixel-for-pixel.
  qualityCtx.filter = `brightness(${1 + brightness / 100}) contrast(${contrast})`;
  qualityCtx.drawImage(qualityRefImg, 0, 0, w, h);
  qualityCtx.filter = "none";

  if (sharpness > 0) {
    // Unsharp mask: blend the current (brightness/contrast-adjusted) canvas
    // against a blurred copy of itself, same idea as the backend's
    // GaussianBlur + addWeighted step.
    const blurCanvas = document.createElement("canvas");
    blurCanvas.width = w;
    blurCanvas.height = h;
    const blurCtx = blurCanvas.getContext("2d");
    blurCtx.filter = "blur(3px)";
    blurCtx.drawImage(qualityCanvas, 0, 0);

    const base = qualityCtx.getImageData(0, 0, w, h);
    const blurred = blurCtx.getImageData(0, 0, w, h);
    const out = base.data;
    for (let i = 0; i < out.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        out[i + c] = Math.min(255, Math.max(0, out[i + c] + sharpness * (out[i + c] - blurred.data[i + c])));
      }
    }
    qualityCtx.putImageData(base, 0, 0);
  }
}

function resetImageQualityPreview() {
  document.getElementById("qualityBrightness").value = 0;
  document.getElementById("qualityContrast").value = 1;
  document.getElementById("qualitySharpness").value = 0;
  drawQualityPreview();
}

async function saveImageQuality() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_brightness: parseFloat(document.getElementById("qualityBrightness").value),
      image_contrast: parseFloat(document.getElementById("qualityContrast").value),
      image_sharpness: parseFloat(document.getElementById("qualitySharpness").value),
    }),
  });
  alert("Saved.");
}

// --- Reference image perspective correction (client-side trace, server-side warp) ---

let perspRefImg = new Image();
let perspPoints = []; // up to 4 {x,y} in native reference-image pixel coords, TL->TR->BR->BL
const perspCanvas = document.getElementById("perspCanvas");
const perspCtx = perspCanvas.getContext("2d");
let perspScale = 1;
const PERSP_CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];

function loadPerspectivePreview() {
  perspRefImg = new Image();
  perspRefImg.onload = () => {
    perspPoints = [];
    const maxW = 860;
    perspScale = perspRefImg.width > maxW ? maxW / perspRefImg.width : 1;
    perspCanvas.width = perspRefImg.width * perspScale;
    perspCanvas.height = perspRefImg.height * perspScale;
    drawPerspectivePreview();
  };
  perspRefImg.src = `${API}/reference?ts=` + Date.now();
}

function drawPerspectivePreview() {
  if (!perspRefImg.width) return;
  perspCtx.clearRect(0, 0, perspCanvas.width, perspCanvas.height);
  perspCtx.drawImage(perspRefImg, 0, 0, perspCanvas.width, perspCanvas.height);

  perspCtx.strokeStyle = "#e63946";
  perspCtx.fillStyle = "#e63946";
  perspCtx.lineWidth = 2;
  perspCtx.font = "14px monospace";
  perspPoints.forEach((p, i) => {
    const x = p.x * perspScale, y = p.y * perspScale;
    perspCtx.beginPath();
    perspCtx.arc(x, y, 5, 0, Math.PI * 2);
    perspCtx.fill();
    perspCtx.fillText(i + 1, x + 8, y - 8);
  });
  if (perspPoints.length > 1) {
    perspCtx.beginPath();
    perspPoints.forEach((p, i) => {
      const x = p.x * perspScale, y = p.y * perspScale;
      if (i === 0) perspCtx.moveTo(x, y); else perspCtx.lineTo(x, y);
    });
    if (perspPoints.length === 4) perspCtx.closePath();
    perspCtx.stroke();
  }
  document.getElementById("perspStatus").textContent =
    perspPoints.length < 4
      ? `Click-drag to place the ${PERSP_CORNER_NAMES[perspPoints.length]} corner of the display (${perspPoints.length}/4)`
      : "4 corners traced - drag any corner to adjust, or click Apply to rectify.";
}

let perspDragIndex = -1;

function perspEventToNativeXY(e) {
  const rect = perspCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / perspScale,
    y: (e.clientY - rect.top) / perspScale,
  };
}

perspCanvas.addEventListener("mousedown", (e) => {
  const { x, y } = perspEventToNativeXY(e);
  const grabRadius = 10 / perspScale;
  let nearest = -1, nearestDist = grabRadius;
  perspPoints.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < nearestDist) { nearest = i; nearestDist = d; }
  });
  if (nearest >= 0) {
    perspDragIndex = nearest;
  } else if (perspPoints.length < 4) {
    perspPoints.push({ x: Math.round(x), y: Math.round(y) });
    perspDragIndex = perspPoints.length - 1;
  } else {
    return;
  }
  drawPerspectivePreview();
});

perspCanvas.addEventListener("mousemove", (e) => {
  if (perspDragIndex < 0) return;
  const { x, y } = perspEventToNativeXY(e);
  perspPoints[perspDragIndex] = { x: Math.round(x), y: Math.round(y) };
  drawPerspectivePreview();
});

window.addEventListener("mouseup", () => { perspDragIndex = -1; });

function resetPerspectivePreview() {
  perspPoints = [];
  drawPerspectivePreview();
}

async function applyPerspective() {
  if (perspPoints.length !== 4) return alert("Trace all 4 corners first");
  if (rois.length && !confirm(
    "Applying this perspective correction will clear the existing ROI boxes, since their " +
    "coordinates would no longer line up. Continue?"
  )) return;

  const res = await fetch(`${API}/reference/perspective`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ corners: perspPoints }),
  });
  const j = await res.json();
  if (j.error) return alert(j.error);

  rois = [];
  loadReferenceIntoCanvas();
  loadRotatePreview();
  loadPerspectivePreview();
  loadQualityPreview();
  alert("Perspective corrected." + (j.cleared_rois ? " ROI boxes were cleared - redraw them below." : ""));
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
      auto_capture_enabled: document.getElementById("autoCaptureEnabled").checked,
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

async function saveDebugMode() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      debug_mode: document.getElementById("debugMode").checked,
    }),
  });
  alert("Saved.");
}

function formatDebugTimestamp(ts) {
  // ts looks like 20260827T153045123456 (UTC, no separators)
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return ts;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return new Date(iso).toLocaleString();
}

let debugEntries = [];
const DEBUG_PAGE_SIZE = 10;

async function loadDebugGallery() {
  debugEntries = await (await fetch(`${API}/debug`)).json();
  document.getElementById("debugImage").style.display = "none";
  renderDebugTable(DEBUG_PAGE_SIZE);
}

function renderDebugTable(limit) {
  const table = document.getElementById("debugTable");
  const showAllBtn = document.getElementById("debugShowAll");

  if (!debugEntries.length) {
    table.innerHTML = "<tr><td>No failed readings recorded.</td></tr>";
    showAllBtn.style.display = "none";
    return;
  }

  const shown = limit ? debugEntries.slice(0, limit) : debugEntries;
  table.innerHTML = shown.map((e) => `
    <tr class="debugRow" data-ts="${e.timestamp}" style="cursor:pointer;">
      <td style="font-family:monospace; padding:2px 12px 2px 0; white-space:nowrap;">${formatDebugTimestamp(e.timestamp)}</td>
      <td>${e.reason}</td>
    </tr>
  `).join("");

  table.querySelectorAll(".debugRow").forEach((row) => {
    row.addEventListener("click", () => showDebugImage(row.dataset.ts));
  });

  showAllBtn.style.display = (limit && debugEntries.length > limit) ? "inline-block" : "none";
}

function showAllDebugEntries() {
  renderDebugTable(null);
}

function showDebugImage(timestamp) {
  const image = document.getElementById("debugImage");
  image.src = `${API}/debug/${timestamp}/image`;
  image.style.display = "block";
  image.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function overrideReading() {
  const raw = document.getElementById("overrideValue").value;
  const status = document.getElementById("overrideStatus");
  if (raw === "") {
    status.textContent = "Enter a value first.";
    return;
  }
  const res = await fetch(`${API}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: parseFloat(raw) }),
  });
  const j = await res.json();
  if (!res.ok) {
    status.textContent = "Error: " + j.error;
    return;
  }
  status.textContent = `Baseline set to ${j.value} at ${new Date(j.timestamp).toLocaleString()}.`;
  document.getElementById("overrideValue").value = "";
  loadHistoryChart();
}

async function saveMqtt() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mqtt_host: document.getElementById("mqttHost").value,
      mqtt_port: parseInt(document.getElementById("mqttPort").value || "1883"),
      mqtt_topic_prefix: document.getElementById("mqttTopicPrefix").value,
      mqtt_username: document.getElementById("mqttUser").value,
      mqtt_password: document.getElementById("mqttPass").value,
    }),
  });
  alert("Saved.");
}

function setMqttUnit(value) {
  document.getElementById("mqttUnit").value = value;
}

function setMqttDeviceClass(value) {
  document.getElementById("mqttDeviceClass").value = value;
}

async function saveMqttDiscovery() {
  await fetch(`${API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mqtt_discovery: document.getElementById("mqttDiscovery").checked,
      mqtt_discovery_prefix: document.getElementById("mqttDiscoveryPrefix").value,
      mqtt_unit_of_measurement: document.getElementById("mqttUnit").value,
      mqtt_device_class: document.getElementById("mqttDeviceClass").value,
    }),
  });
  alert("Saved.");
}

async function runTest(fromSnapshot) {
  const fd = new FormData();
  if (fromSnapshot) {
    fd.append("from_snapshot", "true");
  } else {
    const f = document.getElementById("testFile").files[0];
    if (f) fd.append("file", f);
  }
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

async function runTestFromSnapshot() {
  runTest(true);
}

// --- Last processed image ---

async function loadLastImage() {
  const lastImage = document.getElementById("lastImage");
  const status = document.getElementById("lastImageStatus");
  const res = await fetch(`${API}/last/image?ts=` + Date.now());
  if (!res.ok) {
    lastImage.style.display = "none";
    status.textContent = "No processed image yet.";
    return;
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  lastImage.onload = () => URL.revokeObjectURL(blobUrl);
  lastImage.src = blobUrl;
  lastImage.style.display = "block";
  status.textContent = "";
}

// --- History chart ---

let historyData = [];
let historyPlot = null;
const historyCanvas = document.getElementById("historyCanvas");
const historyCtx = historyCanvas.getContext("2d");

async function loadHistoryChart() {
  historyData = await (await fetch(`${API}/history`)).json();
  drawHistoryChart();
}

function drawHistoryChart() {
  const w = Math.min(860, historyCanvas.parentElement.clientWidth || 860);
  const h = 260;
  historyCanvas.width = w;
  historyCanvas.height = h;
  historyCtx.clearRect(0, 0, w, h);

  if (!historyData.length) {
    historyPlot = null;
    historyCtx.fillStyle = "#777";
    historyCtx.font = "14px sans-serif";
    historyCtx.fillText("No history yet.", 10, 20);
    return;
  }

  const pad = { left: 65, right: 15, top: 15, bottom: 30 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const points = historyData.map((e) => ({ t: new Date(e.timestamp).getTime(), v: e.value, entry: e }));
  let minV = Math.min(...points.map((p) => p.v));
  let maxV = Math.max(...points.map((p) => p.v));
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);

  const xOf = (t) => pad.left + ((t - minT) / spanT) * plotW;
  const yOf = (v) => pad.top + (1 - (v - minV) / (maxV - minV)) * plotH;

  historyCtx.strokeStyle = "#ccc";
  historyCtx.lineWidth = 1;
  historyCtx.strokeRect(pad.left, pad.top, plotW, plotH);

  historyCtx.fillStyle = "#555";
  historyCtx.font = "12px monospace";
  historyCtx.textAlign = "right";
  historyCtx.fillText(maxV.toFixed(3), pad.left - 6, pad.top + 4);
  historyCtx.fillText(minV.toFixed(3), pad.left - 6, pad.top + plotH);

  historyCtx.textAlign = "left";
  historyCtx.fillText(new Date(minT).toLocaleString(), pad.left, h - 8);
  historyCtx.textAlign = "right";
  historyCtx.fillText(new Date(maxT).toLocaleString(), w - pad.right, h - 8);

  historyCtx.strokeStyle = "#2f6fed";
  historyCtx.lineWidth = 2;
  historyCtx.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p.t), y = yOf(p.v);
    if (i === 0) historyCtx.moveTo(x, y); else historyCtx.lineTo(x, y);
  });
  historyCtx.stroke();

  historyCtx.fillStyle = "#2f6fed";
  points.forEach((p) => {
    historyCtx.beginPath();
    historyCtx.arc(xOf(p.t), yOf(p.v), 2.5, 0, Math.PI * 2);
    historyCtx.fill();
  });

  historyPlot = { pad, plotW, plotH, minT, maxT, spanT, points };
}

historyCanvas.addEventListener("mousemove", (e) => {
  if (!historyPlot) return;
  const rect = historyCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const t = historyPlot.minT + ((mx - historyPlot.pad.left) / historyPlot.plotW) * historyPlot.spanT;
  let nearest = historyPlot.points[0], nearestDist = Infinity;
  historyPlot.points.forEach((p) => {
    const d = Math.abs(p.t - t);
    if (d < nearestDist) { nearestDist = d; nearest = p; }
  });
  document.getElementById("historyTooltip").textContent =
    `${new Date(nearest.entry.timestamp).toLocaleString()} - value: ${nearest.entry.value}`;
});

historyCanvas.addEventListener("mouseleave", () => {
  document.getElementById("historyTooltip").textContent = "";
});

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
  document.getElementById("qualityBrightness").value = cfg.image_brightness || 0;
  document.getElementById("qualityContrast").value = cfg.image_contrast || 1;
  document.getElementById("qualitySharpness").value = cfg.image_sharpness || 0;
  document.getElementById("espUrl").value = cfg.esp_snapshot_url || "";
  document.getElementById("pollInterval").value = cfg.poll_interval_seconds;
  document.getElementById("autoCaptureEnabled").checked = cfg.auto_capture_enabled !== false;
  document.getElementById("allowDigitFallback").checked = !!cfg.allow_digit_fallback;
  document.getElementById("rejectDecreasing").checked = !!cfg.reject_decreasing;
  document.getElementById("maxIncrease").value = cfg.max_increase_per_reading || 0;
  document.getElementById("debugMode").checked = !!cfg.debug_mode;
  document.getElementById("mqttHost").value = cfg.mqtt_host || "";
  document.getElementById("mqttPort").value = cfg.mqtt_port;
  document.getElementById("mqttTopicPrefix").value = cfg.mqtt_topic_prefix;
  document.getElementById("mqttUser").value = cfg.mqtt_username || "";
  document.getElementById("mqttDiscovery").checked = !!cfg.mqtt_discovery;
  document.getElementById("mqttDiscoveryPrefix").value = cfg.mqtt_discovery_prefix || "";
  document.getElementById("mqttUnit").value = cfg.mqtt_unit_of_measurement || "";
  document.getElementById("mqttDeviceClass").value = cfg.mqtt_device_class || "";
  rois = cfg.rois || [];
}

window.onload = async () => {
  // Fetch the saved config (incl. rois) before drawing the reference image,
  // so the ROI boxes are already known by the time the canvas first renders.
  await refreshStatus();
  loadReferenceIntoCanvas();
  loadRotatePreview();
  loadPerspectivePreview();
  loadQualityPreview();
  loadLastImage();
  loadHistoryChart();
  loadDebugGallery();
};
