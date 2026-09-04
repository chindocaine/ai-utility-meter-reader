"""
Utility meter reader service.

Receives / fetches images of a mechanical roller-digit utility meter (water,
gas, electricity, ...), aligns them against a stored reference image using
feature-based registration (robust to small camera shifts and glare, unlike
small-marker alignment), crops each digit window, runs a TFLite
digit-classifier model (reuses the model format used by the "AI on the edge"
project) and assembles a final numeric reading.

Supports multiple independent meter instances (each with its own name,
reference image, model assignment, ROIs and history), so one deployment can
track e.g. a water meter and a gas meter side by side.

Run with: python main.py   (or via the provided Dockerfile)
"""

import os
import io
import json
import math
import re
import shutil
import time
import threading
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone

import cv2
import numpy as np
from flask import Flask, request, jsonify, send_file, render_template
from waitress import serve

try:
    from tflite_runtime.interpreter import Interpreter
except ImportError:  # fallback if tflite_runtime wheel isn't available for this platform
    from tensorflow.lite.python.interpreter import Interpreter  # type: ignore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("utilitymeter")

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR = DATA_DIR / "models"  # shared across all meters - tflite files are reusable
MODELS_DIR.mkdir(parents=True, exist_ok=True)
METERS_DIR = DATA_DIR / "meters"
METERS_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_METER_CONFIG = {
    "name": "Meter",
    "rois": [],                     # list of {x,y,w,h} in reference-image pixel coords, left -> right
    "decimal_digits": 3,            # how many of the trailing ROIs are after the decimal point
    "model_file": None,             # filename inside MODELS_DIR
    "num_classes": 10,              # 10 = plain digits, 11 = class11 (+uncertain), 100 = class100
                                    # (sub-digit continuous), 2 = dig-cont (2-output atan2 regression)
    "alignment_method": "orb",      # "orb" or "phase" (phase = translation-only, cheaper)
    "min_match_count": 12,
    "transition_low": 0.25,         # heuristics for resolving a roller mid-transition
    "transition_high": 0.75,
    "esp_snapshot_url": "",         # optional: URL to pull a raw JPEG from periodically
    "poll_interval_seconds": 300,
    "allow_digit_fallback": True,   # if a digit can't be read, reuse that position's digit
                                    # from the last accepted reading instead of failing
    "reject_decreasing": True,      # reject a reading lower than the last accepted one
    "max_increase_per_reading": 0,  # reject a reading that jumps more than this above the
                                    # last accepted one; 0 = no limit
    "debug_mode": False,            # save an annotated snapshot for every failed reading
                                    # (alignment failure, unreadable digit, outlier rejection)
    "mqtt_host": "",
    "mqtt_port": 1883,
    "mqtt_topic": "utilitymeter/value",
    "mqtt_username": "",
    "mqtt_password": "",
}

_lock = threading.Lock()
_last_results = {}  # meter_id -> {"value":..., "timestamp":..., "error":...}
_interpreter_cache = {"path": None, "interpreter": None, "input_details": None, "output_details": None}
_next_poll_at = {}  # meter_id -> earliest epoch time the poller should try this meter again


# ---------------------------------------------------------------------------
# Meter management
# ---------------------------------------------------------------------------

def meter_dir(meter_id):
    return METERS_DIR / meter_id


def meter_config_path(meter_id):
    return meter_dir(meter_id) / "config.json"


def reference_path(meter_id):
    return meter_dir(meter_id) / "reference.jpg"


def last_raw_path(meter_id):
    return meter_dir(meter_id) / "last_raw.jpg"


def last_annotated_path(meter_id):
    return meter_dir(meter_id) / "last_annotated.jpg"


def history_path(meter_id):
    return meter_dir(meter_id) / "history.jsonl"


def pending_path(meter_id):
    return meter_dir(meter_id) / "pending.json"


def debug_dir(meter_id):
    return meter_dir(meter_id) / "debug"


def meter_exists(meter_id):
    return meter_config_path(meter_id).exists()


def load_meter_config(meter_id):
    with open(meter_config_path(meter_id), "r") as f:
        cfg = json.load(f)
    merged = dict(DEFAULT_METER_CONFIG)
    merged.update(cfg)
    return merged


def save_meter_config(meter_id, cfg):
    with open(meter_config_path(meter_id), "w") as f:
        json.dump(cfg, f, indent=2)


def list_meters():
    meters = []
    for d in METERS_DIR.iterdir():
        if (d / "config.json").exists():
            cfg = load_meter_config(d.name)
            meters.append({"id": d.name, "name": cfg["name"]})
    meters.sort(key=lambda m: m["name"].lower())
    return meters


def create_meter(name):
    meter_id = uuid.uuid4().hex[:12]
    meter_dir(meter_id).mkdir(parents=True, exist_ok=True)
    cfg = dict(DEFAULT_METER_CONFIG)
    cfg["name"] = name or "Meter"
    save_meter_config(meter_id, cfg)
    return meter_id


def delete_meter(meter_id):
    d = meter_dir(meter_id)
    if d.exists():
        shutil.rmtree(d)
    with _lock:
        _last_results.pop(meter_id, None)
        _next_poll_at.pop(meter_id, None)


# ---------------------------------------------------------------------------
# TFLite digit model
# ---------------------------------------------------------------------------

def get_interpreter(model_path: Path):
    """Load (and cache) the tflite interpreter, auto-detecting its input tensor shape/dtype
    so we don't have to hardcode the exact size used by a given AI-on-the-edge model version."""
    if _interpreter_cache["path"] == str(model_path) and _interpreter_cache["interpreter"] is not None:
        return _interpreter_cache["interpreter"], _interpreter_cache["input_details"], _interpreter_cache["output_details"]

    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()[0]
    output_details = interpreter.get_output_details()[0]

    _interpreter_cache.update({
        "path": str(model_path),
        "interpreter": interpreter,
        "input_details": input_details,
        "output_details": output_details,
    })
    return interpreter, input_details, output_details


def preprocess_crop(crop, input_details):
    """Resize/convert a digit crop to whatever the loaded tflite model expects."""
    shape = input_details["shape"]  # e.g. [1, H, W, C]
    _, h, w, c = int(shape[0]), int(shape[1]), int(shape[2]), int(shape[3])

    if c == 1:
        img = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        img = cv2.resize(img, (w, h))
        img = np.expand_dims(img, axis=-1)
    else:
        img = cv2.resize(crop, (w, h))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    # AI-on-the-edge's own firmware (CTfLiteClass::LoadInputImageBasis) feeds
    # the raw 0-255 pixel value straight into the model with no 0.0-1.0
    # normalization - these models are trained/quantized against that exact
    # convention, so we must match it rather than the usual ML "divide by 255".
    dtype = input_details["dtype"]
    if dtype == np.float32:
        img = img.astype(np.float32)
    else:
        # Quantized (uint8/int8) model: map the raw 0-255 pixel value onto the
        # model's actual quantized range via its scale/zero_point, rather than
        # a raw dtype cast - a plain `.astype(int8)` wraps values >= 128 into
        # negative numbers instead of remapping them, corrupting every crop
        # the same way regardless of what digit it shows.
        scale, zero_point = input_details.get("quantization", (0.0, 0))
        if scale:
            img = np.round(img.astype(np.float32) / scale + zero_point)
            info = np.iinfo(dtype)
            img = np.clip(img, info.min, info.max).astype(dtype)
        else:
            img = img.astype(dtype)

    return np.expand_dims(img, axis=0)


def run_digit_model(crop, model_path: Path, num_classes: int, debug=False):
    interpreter, input_details, output_details = get_interpreter(model_path)
    tensor = preprocess_crop(crop, input_details)
    interpreter.set_tensor(input_details["index"], tensor)
    interpreter.invoke()
    output = interpreter.get_tensor(output_details["index"])[0]

    output_len = output.shape[-1]

    if output_len != num_classes:
        log.warning(
            "Configured num_classes=%s doesn't match model output size %s - "
            "check the 'output classes' setting for this model",
            num_classes, output_len,
        )

    is_valid = True

    if output_len == 2:
        # "cont" / Analogue models (e.g. dig-cont_*.tflite): not a classifier at
        # all. The two outputs encode the roller angle the same way
        # AI-on-the-edge's own C++ decoder does (ClassFlowCNNGeneral.cpp):
        # angle = atan2(out0, out1), normalized to [0,1) then scaled to [0,10).
        f1, f2 = float(output[0]), float(output[1])
        angle_frac = math.fmod(math.atan2(f1, f2) / (2 * math.pi) + 2, 1)
        raw_value = angle_frac * 10.0
        confidence = 1.0  # regression output - no softmax confidence available
    else:
        class_idx = int(np.argmax(output))
        confidence = float(output[class_idx])

        if output_len == 11:
            # class11 models: classes 0-9 are plain digits, class 10 is a reserved
            # "unreadable" marker (blur / mid-roll / uncertain) - it must NOT be
            # treated as a continuous value close to 9.
            if class_idx == 10:
                is_valid = False
                raw_value = None
            else:
                raw_value = float(class_idx)
        else:
            # class10: class_idx IS the digit (output_len == 10 -> raw_value == class_idx).
            # class100-style: classes represent continuous sub-digit steps between
            # 0.0 and 10.0, used to detect a roller that's mid-transition.
            raw_value = class_idx * (10.0 / output_len)

    if debug:
        debug_info = {
            "input_shape": [int(x) for x in input_details["shape"]],
            "input_dtype": str(input_details["dtype"]),
            "input_quantization": input_details.get("quantization"),
            "tensor_min": float(tensor.min()),
            "tensor_max": float(tensor.max()),
            "tensor_mean": float(tensor.mean()),
            "output_len": int(output_len),
            "output_values": [float(v) for v in output],
            "output_top5_idx": [int(i) for i in np.argsort(output)[::-1][:5]],
            "output_top5_val": [float(output[i]) for i in np.argsort(output)[::-1][:5]],
            "is_valid": is_valid,
        }
        return raw_value, confidence, is_valid, debug_info
    return raw_value, confidence, is_valid


def align_image(img, reference, method, min_match_count):
    """Register img against reference. Returns (aligned_img, success_bool)."""
    ref_h, ref_w = reference.shape[:2]
    gray_img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray_ref = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)

    if method == "phase":
        try:
            from skimage.registration import phase_cross_correlation
        except ImportError:
            log.warning("scikit-image not installed, falling back to ORB alignment")
            method = "orb"

    if method == "phase":
        shift, _error, _phase = phase_cross_correlation(gray_ref, gray_img)
        M = np.float32([[1, 0, shift[1]], [0, 1, shift[0]]])
        aligned = cv2.warpAffine(img, M, (ref_w, ref_h))
        return aligned, True

    # ORB feature-based homography (robust to shift/rotation/local glare)
    orb = cv2.ORB_create(800)
    kp1, des1 = orb.detectAndCompute(gray_img, None)
    kp2, des2 = orb.detectAndCompute(gray_ref, None)
    if des1 is None or des2 is None or len(kp1) < min_match_count or len(kp2) < min_match_count:
        return None, False

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = matcher.match(des1, des2)
    matches = sorted(matches, key=lambda m: m.distance)
    good = matches[: max(min_match_count, int(len(matches) * 0.2))]
    if len(good) < min_match_count:
        return None, False

    src_pts = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst_pts = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
    if H is None:
        return None, False
    inliers = int(mask.sum()) if mask is not None else 0
    if inliers < min_match_count:
        return None, False

    aligned = cv2.warpPerspective(img, H, (ref_w, ref_h))
    return aligned, True


def resolve_digit(raw_value, right_neighbor_raw, is_rightmost, cfg):
    """Turn a continuous 0.0-9.99 reading into a final integer digit 0-9,
    resolving the classic mechanical-roller ambiguity: a digit briefly shows a
    blend of two numbers while the next (less significant) digit rolls over.
    Heuristic, tunable via transition_low/transition_high in config.
    Returns None if raw_value itself is unreadable (see run_digit_model)."""
    if raw_value is None:
        return None

    floor_v = math.floor(raw_value) % 10
    frac = raw_value - math.floor(raw_value)

    if is_rightmost or right_neighbor_raw is None:
        return int(round(raw_value)) % 10

    if cfg["transition_low"] < frac < cfg["transition_high"]:
        # Ambiguous / mid-roll. If the digit to the right is still high (close
        # to 9), it hasn't wrapped yet -> this digit hasn't incremented yet.
        # If the digit to the right already reads low (just wrapped to 0),
        # this digit has already incremented.
        if right_neighbor_raw >= 5.0:
            return floor_v
        else:
            return (floor_v + 1) % 10
    return int(round(raw_value)) % 10


def process_image(img, cfg, ref_path, debug=False, fallback_digits=None):
    """Full pipeline: align -> crop ROIs -> classify -> assemble value.
    Returns dict with value, per-digit debug info, and an annotated preview image.

    fallback_digits, if given, is the digit list from the last accepted reading.
    A digit the model couldn't read is filled in from here (same behavior as
    AI-on-the-edge) instead of failing the whole reading outright - on the
    assumption that an unreadable digit more often means a blurry/mid-roll
    frame than an actual change, especially for more-significant digits that
    rarely tick over. Still-unresolvable digits (no fallback available) fail
    the reading exactly as before."""
    if not ref_path.exists():
        raise RuntimeError("No reference image configured yet")
    if not cfg["rois"]:
        raise RuntimeError("No digit ROIs configured yet")
    if not cfg["model_file"]:
        raise RuntimeError("No tflite model configured yet")

    reference = cv2.imread(str(ref_path))
    aligned, ok = align_image(img, reference, cfg["alignment_method"], cfg["min_match_count"])
    if not ok:
        raise RuntimeError("Image alignment failed (not enough matched features)")

    model_path = MODELS_DIR / cfg["model_file"]
    raw_values = []
    confidences = []
    valid_flags = []
    debug_entries = []
    crop_thumbs = []
    for roi in cfg["rois"]:
        x, y, w, h = roi["x"], roi["y"], roi["w"], roi["h"]
        crop = aligned[y:y + h, x:x + w]
        if debug:
            raw_v, conf, is_valid, dbg = run_digit_model(crop, model_path, cfg["num_classes"], debug=True)
            debug_entries.append(dbg)
            ok2, buf = cv2.imencode(".png", crop)
            crop_thumbs.append(buf.tobytes() if ok2 else b"")
        else:
            raw_v, conf, is_valid = run_digit_model(crop, model_path, cfg["num_classes"])
        raw_values.append(raw_v)
        confidences.append(conf)
        valid_flags.append(is_valid)

    n = len(raw_values)
    final_digits = [None] * n
    for i in range(n - 1, -1, -1):
        is_rightmost = i == n - 1
        right_neighbor = raw_values[i + 1] if not is_rightmost else None
        final_digits[i] = resolve_digit(raw_values[i], right_neighbor, is_rightmost, cfg)

    substituted_positions = []
    if cfg.get("allow_digit_fallback", True) and fallback_digits:
        for i, d in enumerate(final_digits):
            if d is None and i < len(fallback_digits) and fallback_digits[i] is not None:
                final_digits[i] = fallback_digits[i]
                substituted_positions.append(i)

    invalid_positions = [i for i, d in enumerate(final_digits) if d is None]
    if invalid_positions and not debug:
        raise RuntimeError(
            f"Digit(s) at position(s) {invalid_positions} unreadable (model returned its "
            "uncertain/NaN class) and no previous reading available to fall back on - "
            "check alignment and ROI placement"
        )

    if invalid_positions:
        value = None
    else:
        digit_str = "".join(str(d) for d in final_digits)
        dec = cfg["decimal_digits"]
        if dec > 0 and dec < len(digit_str):
            int_part = digit_str[:-dec]
            frac_part = digit_str[-dec:]
            value = float(f"{int_part}.{frac_part}")
        else:
            value = float(digit_str)

    annotated = aligned.copy()
    for i, (roi, d, conf) in enumerate(zip(cfg["rois"], final_digits, confidences)):
        x, y, w, h = roi["x"], roi["y"], roi["w"], roi["h"]
        if d is None:
            color, label = (0, 0, 220), "?"
        elif i in substituted_positions:
            color, label = (200, 0, 200), str(d) + "*"  # carried over from the last reading
        else:
            color = (0, 200, 0) if conf > 0.6 else (0, 140, 255)
            label = str(d)
        cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)
        cv2.putText(annotated, label, (x + 2, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    result = {
        "value": value,
        "digits": final_digits,
        "raw_values": raw_values,
        "confidences": confidences,
        "valid": valid_flags,
        "invalid_positions": invalid_positions,
        "substituted_positions": substituted_positions,
        "annotated": annotated,
    }
    if debug:
        result["debug_entries"] = debug_entries
        result["crop_thumbs"] = crop_thumbs
    return result


def publish_mqtt(cfg, value):
    if not cfg.get("mqtt_host"):
        return
    try:
        import paho.mqtt.publish as publish
        auth = None
        if cfg.get("mqtt_username"):
            auth = {"username": cfg["mqtt_username"], "password": cfg.get("mqtt_password", "")}
        publish.single(
            cfg["mqtt_topic"], payload=json.dumps({"value": value}),
            hostname=cfg["mqtt_host"], port=int(cfg.get("mqtt_port", 1883)), auth=auth,
        )
    except Exception as e:
        log.warning("MQTT publish failed: %s", e)


def get_last_accepted(meter_id):
    """Value + per-digit digit list from the last reading that actually made it
    into history - used both as the outlier-check baseline and as the source
    for filling in individually-unreadable digits. Falls back to on-disk
    history (rather than only the in-memory cache) so both still work right
    after a restart."""
    with _lock:
        cached = _last_results.get(meter_id, {})
        if cached.get("value") is not None and cached.get("digits") is not None:
            return {"value": cached["value"], "digits": cached["digits"]}

    hp = history_path(meter_id)
    if hp.exists():
        for line in reversed(hp.read_text().strip().splitlines()):
            if not line:
                continue
            entry = json.loads(line)
            if entry.get("value") is not None:
                return {"value": entry["value"], "digits": entry.get("digits")}
    return {"value": None, "digits": None}


def load_pending(meter_id):
    """The one buffered-but-not-yet-accepted reading for this meter, if any -
    see handle_new_image for the one-reading confirmation buffer this backs."""
    p = pending_path(meter_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def save_pending(meter_id, entry):
    p = pending_path(meter_id)
    if entry is None:
        p.unlink(missing_ok=True)
        return
    with open(p, "w") as f:
        json.dump(entry, f)


def digits_from_value(value, cfg):
    """Best-effort per-position digit list for a manually-entered override
    value, so digit-level fallback (allow_digit_fallback) has something to
    carry forward until the next successful model read. Only meaningful when
    the value's digit count matches the configured ROIs; otherwise returns
    None and fallback simply won't kick in until a real reading succeeds."""
    n = len(cfg["rois"])
    if n <= 0 or value is None:
        return None
    dec = cfg["decimal_digits"]
    scaled = int(round(value * (10 ** dec)))
    if scaled < 0:
        return None
    s = str(scaled).zfill(n)
    if len(s) != n:
        return None
    return [int(c) for c in s]


def check_plausible_reading(value, last_value, cfg):
    """Reject a freshly-read value if it looks like an outlier relative to the
    last accepted reading, rather than silently feeding a bad OCR result into
    history/MQTT/Home Assistant."""
    if last_value is None or value is None:
        return

    if cfg.get("reject_decreasing") and value < last_value:
        raise RuntimeError(
            f"Rejected reading {value}: lower than last accepted reading {last_value} "
            "(meter values shouldn't decrease - disable 'reject_decreasing' if this "
            "meter can be reset/replaced)"
        )

    max_step = cfg.get("max_increase_per_reading") or 0
    if max_step > 0 and (value - last_value) > max_step:
        raise RuntimeError(
            f"Rejected reading {value}: increase of {round(value - last_value, 3)} since "
            f"last accepted reading ({last_value}) exceeds max_increase_per_reading={max_step}"
        )


def save_debug_image(meter_id, annotated, reason, max_files=200):
    """Persist an annotated failure snapshot under the meter's debug/ folder,
    labeled with the failure reason, for spot-checking gaps in the reading
    history later. Bounded to the most recent max_files so it can't grow
    unbounded on a meter that fails a lot."""
    d = debug_dir(meter_id)
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")

    labeled = annotated.copy()
    cv2.putText(labeled, reason[:90], (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 220), 2)
    cv2.imwrite(str(d / f"{ts}.jpg"), labeled)
    with open(d / f"{ts}.json", "w") as f:
        json.dump({"timestamp": ts, "reason": reason}, f)

    stems = sorted({p.stem for p in d.glob("*.jpg")})
    for stale in stems[:-max_files]:
        (d / f"{stale}.jpg").unlink(missing_ok=True)
        (d / f"{stale}.json").unlink(missing_ok=True)


def save_debug_snapshot(meter_id, img, cfg, ref_path, fallback_digits, reason):
    """Best-effort annotated preview for a failed reading. Re-runs the pipeline
    with debug=True, which returns a result (with digit boxes) instead of
    raising when digits are unreadable, so most failures still get a useful
    annotated image. Falls back to the raw, unaligned frame when even that
    can't run - e.g. alignment itself failed, so there's no aligned image to
    draw boxes on."""
    try:
        debug_result = process_image(img, cfg, ref_path, debug=True, fallback_digits=fallback_digits)
        annotated = debug_result["annotated"]
    except Exception:
        annotated = img.copy()
    save_debug_image(meter_id, annotated, reason)


def handle_new_image(meter_id, img_bytes, cfg):
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("Could not decode image")

    with open(last_raw_path(meter_id), "wb") as f:
        f.write(img_bytes)

    last_accepted = get_last_accepted(meter_id)
    try:
        result = process_image(img, cfg, reference_path(meter_id), fallback_digits=last_accepted["digits"])
    except Exception as e:
        if cfg.get("debug_mode"):
            save_debug_snapshot(meter_id, img, cfg, reference_path(meter_id), last_accepted["digits"], str(e))
        raise
    cv2.imwrite(str(last_annotated_path(meter_id)), result["annotated"])

    # Written above regardless of outcome, so the setup UI's "last image" view
    # still shows what was actually seen even when the reading gets rejected
    # below.

    # One-reading confirmation buffer: a fresh reading is only accepted (written
    # to history, published, exposed as the current value) once a *subsequent*
    # reading confirms it by being the same or higher. Without this, a single
    # frame misread a little too high (not enough to trip max_increase_per_reading)
    # would permanently become the new "last accepted" baseline, and every
    # correct-but-now-comparatively-lower reading after it would fail
    # reject_decreasing forever. If the next reading doesn't confirm the
    # buffered one but is still plausible against the last *committed* reading,
    # the buffered one is discarded as the likely misread instead.
    pending = load_pending(meter_id)
    baseline_value = pending["value"] if pending is not None else last_accepted["value"]
    try:
        check_plausible_reading(result["value"], baseline_value, cfg)
    except Exception as e:
        if pending is None:
            if cfg.get("debug_mode"):
                save_debug_image(meter_id, result["annotated"], str(e))
            raise
        try:
            check_plausible_reading(result["value"], last_accepted["value"], cfg)
        except Exception:
            if cfg.get("debug_mode"):
                save_debug_image(meter_id, result["annotated"], str(e))
            raise
        log.info(
            "Meter %s: discarding buffered reading %s as a likely misread, superseded by %s",
            meter_id, pending["value"], result["value"],
        )
        pending = None

    committed_entry = None
    if pending is not None:
        committed_entry = pending
        with open(history_path(meter_id), "a") as f:
            f.write(json.dumps(committed_entry) + "\n")
        with _lock:
            _last_results.setdefault(meter_id, {}).update({
                "value": committed_entry["value"],
                "digits": committed_entry["digits"],
                "timestamp": committed_entry["timestamp"],
                "error": None,
            })
        publish_mqtt(cfg, committed_entry["value"])

    new_pending = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "value": result["value"],
        "digits": result["digits"],
        "confidences": [round(c, 3) for c in result["confidences"]],
        "substituted_positions": result["substituted_positions"],
    }
    save_pending(meter_id, new_pending)

    return {
        **new_pending,
        "accepted": committed_entry is not None,
        "committed_reading": committed_entry,
    }


def poller_loop():
    while True:
        now = time.time()
        for meter in list_meters():
            meter_id = meter["id"]
            if now < _next_poll_at.get(meter_id, 0):
                continue
            cfg = load_meter_config(meter_id)
            url = cfg.get("esp_snapshot_url")
            interval = int(cfg.get("poll_interval_seconds", 300)) or 300
            _next_poll_at[meter_id] = now + interval
            if not url:
                continue
            try:
                import requests
                resp = requests.get(url, timeout=15)
                resp.raise_for_status()
                handle_new_image(meter_id, resp.content, cfg)
                log.info("Polled meter %s (%s) -> value=%s", meter_id, cfg["name"], _last_results[meter_id]["value"])
            except Exception as e:
                log.warning("Poll failed for meter %s (%s): %s", meter_id, cfg["name"], e)
                with _lock:
                    _last_results.setdefault(meter_id, {})["error"] = str(e)
        time.sleep(5)


app = Flask(__name__)


@app.route("/")
def overview():
    return render_template("overview.html")


@app.route("/meter/<meter_id>")
def meter_page(meter_id):
    if not meter_exists(meter_id):
        return "No such meter", 404
    cfg = load_meter_config(meter_id)
    return render_template("meter.html", meter_id=meter_id, meter_name=cfg["name"])


@app.route("/api/meters", methods=["GET"])
def api_list_meters():
    return jsonify(list_meters())


@app.route("/api/meters", methods=["POST"])
def api_create_meter():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    meter_id = create_meter(name)
    return jsonify({"id": meter_id, "name": name})


@app.route("/api/meters/<meter_id>", methods=["DELETE"])
def api_delete_meter(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    delete_meter(meter_id)
    return jsonify({"ok": True})


@app.route("/api/meters/<meter_id>/config", methods=["GET"])
def api_get_config(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    return jsonify(load_meter_config(meter_id))


@app.route("/api/meters/<meter_id>/config", methods=["POST"])
def api_set_config(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    cfg = load_meter_config(meter_id)
    body = request.get_json(force=True)
    for key in DEFAULT_METER_CONFIG:
        if key in body:
            cfg[key] = body[key]
    save_meter_config(meter_id, cfg)
    return jsonify(cfg)


@app.route("/api/meters/<meter_id>/reference", methods=["POST"])
def api_upload_reference(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded"}), 400
    f = request.files["file"]
    f.save(str(reference_path(meter_id)))
    return jsonify({"ok": True})


@app.route("/api/meters/<meter_id>/reference/from-snapshot", methods=["POST"])
def api_reference_from_snapshot(meter_id):
    """Grab a fresh image from this meter's configured esp_snapshot_url and use
    it directly as the reference image - saves downloading it and re-uploading
    by hand when you just want to (re)capture a current photo of the meter."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    cfg = load_meter_config(meter_id)
    url = cfg.get("esp_snapshot_url")
    if not url:
        return jsonify({"error": "no snapshot URL configured for this meter"}), 400
    try:
        import requests
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        return jsonify({"error": f"could not fetch snapshot: {e}"}), 400
    with open(reference_path(meter_id), "wb") as f:
        f.write(resp.content)
    return jsonify({"ok": True})


@app.route("/api/meters/<meter_id>/reference", methods=["GET"])
def api_get_reference(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    if not reference_path(meter_id).exists():
        return jsonify({"error": "not set"}), 404
    return send_file(str(reference_path(meter_id)), mimetype="image/jpeg")


@app.route("/api/meters/<meter_id>/reference/rotate", methods=["POST"])
def api_rotate_reference(meter_id):
    """Bake a rotation into the saved reference image (e.g. to correct camera
    skew before drawing ROIs). Since every ROI is an axis-aligned rectangle in
    the reference image's own pixel space, and every live photo is aligned
    against that same reference via homography, rotating+persisting the
    reference itself is what lets ROI boxes stay simple rectangles even when
    the camera was mounted slightly tilted - the setup UI only offers a
    non-destructive client-side preview beforehand and calls this to commit it.
    Existing ROIs are cleared since their pixel coordinates no longer apply
    once the reference's own pixel grid has rotated."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    ref_path = reference_path(meter_id)
    if not ref_path.exists():
        return jsonify({"error": "no reference image set"}), 400

    body = request.get_json(force=True) or {}
    try:
        degrees = float(body.get("degrees", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "degrees must be a number"}), 400
    if degrees == 0:
        return jsonify({"error": "degrees must be non-zero"}), 400

    img = cv2.imread(str(ref_path))
    if img is None:
        return jsonify({"error": "could not read reference image"}), 400

    h, w = img.shape[:2]
    center = (w / 2, h / 2)
    # Expand the output canvas so rotated corners aren't clipped - matches
    # what the client-side rotation preview shows before committing.
    M = cv2.getRotationMatrix2D(center, degrees, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    M[0, 2] += (new_w / 2) - center[0]
    M[1, 2] += (new_h / 2) - center[1]
    rotated = cv2.warpAffine(img, M, (new_w, new_h), borderValue=(255, 255, 255))
    cv2.imwrite(str(ref_path), rotated)

    cfg = load_meter_config(meter_id)
    cleared_rois = bool(cfg["rois"])
    cfg["rois"] = []
    save_meter_config(meter_id, cfg)

    return jsonify({"ok": True, "cleared_rois": cleared_rois})


@app.route("/api/meters/<meter_id>/reference/perspective", methods=["POST"])
def api_perspective_reference(meter_id):
    """Correct perspective in the saved reference image: warp the *whole*
    image with the homography that turns a user-traced quadrilateral (the
    meter display's outline) into an axis-aligned rectangle at the same
    position, expanding the canvas so nothing outside the quad is clipped
    (mirrors how /reference/rotate expands its canvas). Live photos are
    always registered against the reference via ORB feature homography (see
    align_image), which already warps arbitrary perspective onto the
    reference's own pixel grid - so correcting the reference once is enough,
    every future capture is rectified for free by that same warpPerspective
    call. Existing ROIs are cleared since their pixel coordinates no longer
    apply once the reference's pixel grid has changed."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    ref_path = reference_path(meter_id)
    if not ref_path.exists():
        return jsonify({"error": "no reference image set"}), 400

    body = request.get_json(force=True) or {}
    corners = body.get("corners")
    if not isinstance(corners, list) or len(corners) != 4:
        return jsonify({"error": "corners must be a list of 4 {x,y} points, "
                                  "traced clockwise from top-left"}), 400
    try:
        pts = np.float32([[float(c["x"]), float(c["y"])] for c in corners])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "each corner needs numeric x/y"}), 400

    img = cv2.imread(str(ref_path))
    if img is None:
        return jsonify({"error": "could not read reference image"}), 400

    tl, tr, br, bl = pts
    rect_w = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    rect_h = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    if rect_w < 4 or rect_h < 4:
        return jsonify({"error": "traced area is too small"}), 400

    # Map the quad onto a rectangle of that size, anchored at the quad's own
    # top-left, so the rectified area lands roughly where it was traced.
    dst = np.float32([
        [tl[0], tl[1]], [tl[0] + rect_w, tl[1]],
        [tl[0] + rect_w, tl[1] + rect_h], [tl[0], tl[1] + rect_h],
    ])
    H = cv2.getPerspectiveTransform(pts, dst)

    h, w = img.shape[:2]
    src_corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
    warped_corners = cv2.perspectiveTransform(src_corners, H).reshape(-1, 2)
    min_x, min_y = warped_corners.min(axis=0)
    max_x, max_y = warped_corners.max(axis=0)

    # Shift the homography so the fully-warped image lands entirely within a
    # non-negative canvas - otherwise anything warped to negative coords gets
    # clipped by warpPerspective.
    shift = np.float32([[1, 0, -min_x], [0, 1, -min_y], [0, 0, 1]])
    H = shift @ H
    out_w = int(round(max_x - min_x))
    out_h = int(round(max_y - min_y))

    rectified = cv2.warpPerspective(img, H, (out_w, out_h), borderValue=(255, 255, 255))
    cv2.imwrite(str(ref_path), rectified)

    cfg = load_meter_config(meter_id)
    cleared_rois = bool(cfg["rois"])
    cfg["rois"] = []
    save_meter_config(meter_id, cfg)

    return jsonify({"ok": True, "cleared_rois": cleared_rois})


@app.route("/api/models", methods=["GET"])
def api_list_models():
    """Shared pool of uploaded .tflite files - any meter can reuse any of these."""
    return jsonify(sorted(p.name for p in MODELS_DIR.glob("*.tflite")))


@app.route("/api/models", methods=["POST"])
def api_upload_model():
    """Upload a .tflite model into the shared pool (not tied to any one meter -
    each meter then just picks one of these by filename in its own config)."""
    if "file" not in request.files:
        return jsonify({"error": "no file uploaded"}), 400
    f = request.files["file"]
    filename = f.filename
    dest = MODELS_DIR / filename
    f.save(str(dest))

    interpreter, input_details, output_details = get_interpreter(dest)

    return jsonify({
        "ok": True,
        "filename": filename,
        "input_shape": [int(x) for x in input_details["shape"]],
        "input_dtype": str(input_details["dtype"]),
        "output_shape": [int(x) for x in output_details["shape"]],
    })


@app.route("/api/models/<filename>", methods=["DELETE"])
def api_delete_model(filename):
    path = MODELS_DIR / filename
    if not path.exists():
        return jsonify({"error": "no such model"}), 404
    path.unlink()
    return jsonify({"ok": True})


@app.route("/api/meters/<meter_id>/rois", methods=["POST"])
def api_set_rois(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    body = request.get_json(force=True)
    cfg = load_meter_config(meter_id)
    cfg["rois"] = body.get("rois", [])
    save_meter_config(meter_id, cfg)
    return jsonify(cfg["rois"])


@app.route("/api/meters/<meter_id>/test", methods=["POST"])
def api_test(meter_id):
    """Run the pipeline once against an uploaded image (or the last received one)
    without writing it into the persisted history - used by the setup UI."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    cfg = load_meter_config(meter_id)
    if "file" in request.files:
        img_bytes = request.files["file"].read()
    elif last_raw_path(meter_id).exists():
        img_bytes = last_raw_path(meter_id).read_bytes()
    else:
        return jsonify({"error": "no image provided and no last image available"}), 400

    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return jsonify({"error": "could not decode image"}), 400

    debug = str(request.form.get("debug", "false")).lower() in ("1", "true", "yes", "on")

    fallback_digits = get_last_accepted(meter_id)["digits"]

    try:
        result = process_image(img, cfg, reference_path(meter_id), debug=debug, fallback_digits=fallback_digits)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    import base64
    ok, buf = cv2.imencode(".jpg", result["annotated"])
    annotated_b64 = base64.b64encode(buf.tobytes()).decode("ascii")

    response = {
        "value": result["value"],
        "digits": [("?" if d is None else d) for d in result["digits"]],
        "raw_values": [(None if v is None else round(v, 3)) for v in result["raw_values"]],
        "confidences": [round(c, 3) for c in result["confidences"]],
        "valid": result["valid"],
        "invalid_positions": result["invalid_positions"],
        "substituted_positions": result["substituted_positions"],
        "annotated_image": "data:image/jpeg;base64," + annotated_b64,
    }
    if debug:
        response["crop_thumbnails"] = [
            "data:image/png;base64," + base64.b64encode(t).decode("ascii") for t in result["crop_thumbs"]
        ]
        response["debug"] = result["debug_entries"]

    return jsonify(response)


@app.route("/api/meters/<meter_id>/image", methods=["POST"])
def api_receive_image(meter_id):
    """Push endpoint: point your ESP32 (or a cron job on any machine) here with
    the raw JPEG bytes as the request body, or as multipart form field 'file'."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    cfg = load_meter_config(meter_id)
    if "file" in request.files:
        img_bytes = request.files["file"].read()
    else:
        img_bytes = request.get_data()

    if not img_bytes:
        return jsonify({"error": "no image data received"}), 400

    try:
        entry = handle_new_image(meter_id, img_bytes, cfg)
    except Exception as e:
        with _lock:
            _last_results.setdefault(meter_id, {})["error"] = str(e)
        return jsonify({"error": str(e)}), 400

    return jsonify(entry)


@app.route("/api/meters/<meter_id>/last", methods=["GET"])
def api_last(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    with _lock:
        return jsonify(dict(_last_results.get(meter_id, {"value": None, "timestamp": None, "error": None})))


@app.route("/api/meters/<meter_id>/last/image", methods=["GET"])
def api_last_image(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    if not last_annotated_path(meter_id).exists():
        return jsonify({"error": "no processed image yet"}), 404
    return send_file(str(last_annotated_path(meter_id)), mimetype="image/jpeg")


@app.route("/api/meters/<meter_id>/history", methods=["GET"])
def api_history(meter_id):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    hp = history_path(meter_id)
    if not hp.exists():
        return jsonify([])
    lines = hp.read_text().strip().splitlines()[-200:]
    return jsonify([json.loads(l) for l in lines if l])


@app.route("/api/meters/<meter_id>/override", methods=["POST"])
def api_override_reading(meter_id):
    """Manually set the "last accepted reading" baseline - e.g. after a long
    gap with no successful reading during which the meter genuinely advanced
    further than reject_decreasing/max_increase_per_reading would otherwise
    allow the next real reading to be accepted against. Writes a synthetic
    history entry (so it persists across restarts, same as any other accepted
    reading) and becomes the baseline for the next outlier check and digit
    fallback."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    body = request.get_json(force=True) or {}
    try:
        value = float(body["value"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "value is required and must be a number"}), 400

    cfg = load_meter_config(meter_id)
    digits = digits_from_value(value, cfg)

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "value": value,
        "digits": digits,
        "confidences": None,
        "substituted_positions": [],
        "manual_override": True,
    }
    with open(history_path(meter_id), "a") as f:
        f.write(json.dumps(entry) + "\n")

    # Any buffered-but-unconfirmed reading was judged against the old baseline
    # and is now stale - drop it so the next reading is judged fresh against
    # this override instead.
    save_pending(meter_id, None)

    with _lock:
        _last_results.setdefault(meter_id, {}).update({
            "value": value,
            "digits": digits,
            "timestamp": entry["timestamp"],
            "error": None,
        })

    return jsonify(entry)


@app.route("/api/meters/<meter_id>/debug", methods=["GET"])
def api_list_debug(meter_id):
    """List recent failed-reading snapshots (only populated when debug_mode is
    on for this meter), most recent first."""
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    d = debug_dir(meter_id)
    if not d.exists():
        return jsonify([])
    entries = []
    for jf in sorted(d.glob("*.json"), reverse=True):
        try:
            entries.append(json.loads(jf.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    return jsonify(entries[:200])


@app.route("/api/meters/<meter_id>/debug/<timestamp>/image", methods=["GET"])
def api_get_debug_image(meter_id, timestamp):
    if not meter_exists(meter_id):
        return jsonify({"error": "no such meter"}), 404
    if not re.fullmatch(r"[0-9A-Za-z]+", timestamp):
        return jsonify({"error": "invalid id"}), 400
    p = debug_dir(meter_id) / f"{timestamp}.jpg"
    if not p.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(str(p), mimetype="image/jpeg")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    t = threading.Thread(target=poller_loop, daemon=True)
    t.start()
    serve(app, host="0.0.0.0", port=8080)
