# Utility Meter Reader

A small self-hosted service that reads mechanical roller-digit utility meters (water,
gas, electricity, ...) from a photo. Designed to replace "alignment markers" style logic
with proper feature-based image registration, while reusing the digit-classifier
`.tflite` models from the
[AI-on-the-edge-device](https://github.com/jomjol/AI-on-the-edge-device) project.

Supports multiple independent meters in one deployment - e.g. a water meter and a gas
meter side by side, each with its own reference image, model, ROIs and history.

Everything runs locally in one Docker container - no cloud, no LLM, no per-image cost.

## How it works

1. You capture/provide an image of a given meter (see "Getting images in" below).
2. The service aligns it against that meter's stored reference photo using ORB feature
   matching + a homography (robust to camera shift, minor rotation, and localized glare
   - unlike 2-point marker alignment).
3. It crops each digit window (drawn once during setup) and runs your `.tflite` model
   on each crop. The model's input size/dtype is auto-detected, so any of the
   AI-on-the-edge digit models (class10 / class11 / class100 / dig-cont) should work
   as-is.
4. It resolves the classic "roller mid-transition" ambiguity (a digit shows a blend of
   two numbers while the next digit ticks over) using the digit to its right, and
   assembles a final decimal value.
5. Result is available over HTTP (for a Home Assistant REST sensor) and optionally MQTT.

## Quick start

```bash
docker compose up -d --build
```

Then open `http://<host>:8080/` - you'll see the meter overview page. Add a meter
(give it a name, e.g. "Water meter" or "Gas meter"), then open it and:

1. **Upload a reference image** - a clean photo of the meter, ideally similar
   lighting/angle to what the camera normally sees. If the camera is mounted slightly
   tilted, use the "Straighten" preview below the upload to rotate it (in 90°, 1° and
   0.1° steps, with an optional alignment grid overlay) before drawing ROIs - "Apply
   rotation" bakes it into the saved reference image.
2. **Pick a `.tflite` digit model** from the dropdown. Models are uploaded once on the
   meter overview page (`/`) and shared across all meters, so if this is your first
   meter, go upload one there first - grab one straight from AI-on-the-edge's `config/`
   folder (or its GitHub repo), e.g. a `digit_class100_...tflite` file. Pick the
   matching "output classes" option (10 / 11 / 100 / dig-cont) so raw outputs are
   interpreted correctly.
3. **Draw a box over each digit window**, left to right, in the order they appear on
   the meter. Set how many of the trailing digits are after the decimal point (e.g. if
   the last 3 digits are sub-liter/sub-unit digits shown in a different color).
4. **Save alignment settings.** ORB is the robust default; phase-correlation is
   cheaper but only corrects pure shifts, not tilt.
5. **Run a test** with a sample photo to sanity-check the whole pipeline before going
   live - it shows the aligned+annotated image with per-digit boxes and confidences,
   and optionally per-digit debug details (raw model output, crop thumbnails).

Repeat for each additional meter - every meter is fully independent.

## Getting images in (two options)

**Option A - pull (recommended, no ESP32 changes):** if the ESP32 is already running
AI-on-the-edge firmware, it's already serving raw camera frames over HTTP (typically
something like `http://<esp-ip>/img_tmp/raw.jpg` — check your device's web UI /
firmware docs for the exact path, since it can differ by firmware version). Paste that
URL into the "Automatic capture" section of the meter's page along with a poll
interval; the service will pull and process a new frame on that schedule, entirely
independent of the AI-on-the-edge recognition pipeline.

**Option B - push:** `POST` a raw JPEG to `http://<host>:8080/api/meters/<meter-id>/image`
(either as the raw request body, or multipart form field `file`) from any script/cron
job/ESPHome `http_request` action. Find a meter's id in its page URL or via
`GET /api/meters`.

## Home Assistant integration

Simplest option, a REST sensor polling this service (one per meter):

```yaml
sensor:
  - platform: rest
    name: Gas Meter
    resource: http://<host>:8080/api/meters/<meter-id>/last
    value_template: "{{ value_json.value }}"
    unit_of_measurement: "m³"
    device_class: gas
    state_class: total_increasing
    scan_interval: 60
```

Or configure MQTT in the "MQTT" section of a meter's setup page and use an MQTT sensor
instead - useful since you're already running Zigbee2MQTT/Home Assistant on MQTT. Give
each meter a distinct MQTT topic.

## Notes / tuning

- **The roller-transition heuristic is approximate.** The two thresholds
  (`transition_low` / `transition_high` in a meter's config) control how a value's
  fractional part is treated as "mid-roll" vs. "settled". Defaults (0.25 / 0.75) work
  well for most meters but can be tuned if you see off-by-one digit errors right after
  a rollover.
- **`tflite-runtime` wheels** are architecture/Python-version specific. The provided
  `Dockerfile` uses `python:3.11-slim` on the assumption you're building on/for a
  reasonably common architecture (x86_64 or arm64, e.g. a Raspberry Pi 4/5). If the pip
  install fails for your specific board, swap `tflite-runtime` in `requirements.txt`
  for `tensorflow` (heavier, but installs everywhere) - `main.py` already falls back to
  `tensorflow.lite.Interpreter` automatically if `tflite_runtime` isn't installed.
- **Re-take a meter's reference image** if you ever physically move/re-mount its camera.
- **Unreadable digits fall back to the last accepted reading** (same behavior as
  AI-on-the-edge), rather than failing outright - if a digit's model output can't be
  resolved (e.g. a class11 model landing on its "uncertain" class), that position reuses
  the digit from the last accepted reading instead, on the assumption a misread is more
  likely than an actual change, especially for more-significant digits that rarely tick
  over. The annotated test image marks a carried-over digit with a magenta box and a
  `*`. Only if *no* previous reading exists yet (or the position is genuinely out of
  range) does the reading fail outright. Turn this off with "Robustness" &rarr; the
  digit-fallback checkbox if you'd rather every unreadable digit hard-fail. Every
  resulting value - substituted or not - still passes through the outlier checks below
  before it reaches history/MQTT/Home Assistant.
- **Outlier protection.** The "Robustness" section on a meter's page can also reject
  implausible *readable* values: cap the max allowed increase since the last accepted
  reading (catches misreads that land on a wrong-but-valid digit), and/or reject any
  reading lower than the last one (meters normally only count up - turn this off if
  yours can be reset/replaced). A rejected reading surfaces as an error on
  `/api/meters/<id>/last` and leaves the previous value/timestamp in place.
- All state lives under `./data`: uploaded `.tflite` models are shared in
  `./data/models`, and each meter has its own directory under `./data/meters/<id>/`
  holding its config, reference image, and history - so it all survives container
  rebuilds/updates. Deployments upgrading from the single-meter version of this
  service automatically migrate their existing setup into a first meter on startup.
- `GET /api/meters/<meter-id>/history` returns a meter's last 200 readings as JSON if
  you want a quick sanity check or want to feed it elsewhere.

## Endpoints summary

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | Meter overview (add/remove meters) |
| `/meter/<id>` | GET | Setup web UI for one meter |
| `/api/meters` | GET/POST | List meters / create a new meter |
| `/api/meters/<id>` | DELETE | Delete a meter and all its data |
| `/api/meters/<id>/reference` | GET/POST | Get/set a meter's reference image |
| `/api/meters/<id>/reference/rotate` | POST | Rotate the saved reference image (clears ROIs) |
| `/api/models` | GET/POST | List / upload shared `.tflite` models |
| `/api/models/<filename>` | DELETE | Delete a shared `.tflite` model |
| `/api/meters/<id>/rois` | POST | Save a meter's digit ROI boxes |
| `/api/meters/<id>/config` | GET/POST | Read/update a meter's settings (incl. which model it uses) |
| `/api/meters/<id>/test` | POST | Run pipeline on an uploaded/last image, no history write |
| `/api/meters/<id>/image` | POST | Push a new image for processing (writes history) |
| `/api/meters/<id>/last` | GET | Latest reading, for Home Assistant |
| `/api/meters/<id>/last/image` | GET | Latest annotated debug image |
| `/api/meters/<id>/history` | GET | Last 200 readings |
