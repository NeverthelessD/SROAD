#!/usr/bin/env python3
# SROAD AI worker — vocal/instrument separation (Demucs) and pitch/tempo (Rubber Band via pedalboard)
# made by. Nevertheless_D
#
# 사용법: python worker.py job.json
# 진행 상황은 한 줄에 하나씩 JSON으로 출력합니다.
#   {"type":"progress","value":0.42,"stage":"..."}
#   {"type":"result","outputs":{"vocals":"/path.wav", ...}}
#   {"type":"error","message":"..."}
import json
import math
import os
import sys
import threading
import time
import traceback


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(value, stage=None):
    d = {"type": "progress", "value": round(max(0.0, min(1.0, value)), 4)}
    if stage:
        d["stage"] = stage
    emit(**d)


def load_wav(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return data.T.copy(), sr  # (channels, samples)


def save_wav(path, audio, sr):
    import soundfile as sf
    sf.write(path, audio.T, sr, subtype="FLOAT")


# ──────────────────────────────────────────────── 환경 점검
def task_check(job):
    import numpy
    import torch
    import soundfile  # noqa: F401
    import pedalboard
    from demucs.pretrained import get_model  # noqa: F401
    mps = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    emit(type="result", outputs={}, info={
        "torch": torch.__version__, "numpy": numpy.__version__,
        "pedalboard": pedalboard.__version__, "mps": mps,
    })


# ──────────────────────────────────────────────── 음원 분리 (Demucs)
class _ProgressTqdm:
    """demucs.apply 안의 tqdm.tqdm 대신 들어가서 진행률을 알려 줍니다."""

    def __init__(self, reporter):
        self.reporter = reporter

    def tqdm(self, iterable, *args, **kwargs):
        rep = self.reporter
        items = list(iterable)
        total = max(1, len(items))
        k = rep["calls"]
        rep["calls"] += 1
        for i, it in enumerate(items):
            yield it
            rep["fn"](k, (i + 1) / total)


def _separate_on(model, wav, device, reporter):
    import torch
    from demucs.apply import apply_model
    reporter["calls"] = 0
    with torch.no_grad():
        out = apply_model(model, wav[None], device=device, shifts=1, split=True,
                          overlap=0.25, progress=True, num_workers=0)[0]
    return out


def task_separate(job):
    import numpy as np
    import torch
    import demucs.apply as dapply
    from demucs.pretrained import get_model

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    progress(0.0, "AI 모델 불러오는 중")
    model = get_model(job.get("model", "htdemucs"))
    model.eval()
    sources = list(model.sources)
    n_models = len(getattr(model, "models", [model]))

    audio, sr = load_wav(job["input"])
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    elif audio.shape[0] > 2:
        audio = audio[:2]
    if sr != model.samplerate:
        raise RuntimeError(f"샘플레이트가 맞지 않아요 ({sr} ≠ {model.samplerate})")

    wav = torch.from_numpy(audio)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    last = {"t": 0.0}

    def on_progress(k, frac):
        v = (k + frac) / n_models
        now = time.time()
        if now - last["t"] > 0.25 or frac >= 1:
            last["t"] = now
            progress(0.03 + 0.92 * min(1.0, v), "AI가 음원을 분리하는 중")

    reporter = {"calls": 0, "fn": on_progress}
    dapply.tqdm = _ProgressTqdm(reporter)

    want = job.get("device", "auto")
    devices = []
    if want in ("auto", "mps") and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        devices.append("mps")
    devices.append("cpu")

    out = None
    err = None
    for dev in devices:
        try:
            emit(type="info", device=dev)
            progress(0.03, "AI가 음원을 분리하는 중" + (" (GPU 가속)" if dev == "mps" else ""))
            out = _separate_on(model, wav, dev, reporter)
            break
        except Exception as e:  # MPS에서 실패하면 CPU로 다시
            err = e
            traceback.print_exc(file=sys.stderr)
            if dev == "mps":
                progress(0.03, "GPU에서 실패해서 CPU로 다시 시도하는 중")
                continue
            raise
    if out is None:
        raise err or RuntimeError("분리에 실패했어요")

    out = out * std + mean
    out = out.cpu().numpy().astype("float32")
    stems = {name: out[i] for i, name in enumerate(sources)}

    progress(0.96, "파일로 저장하는 중")
    outdir = job["outdir"]
    os.makedirs(outdir, exist_ok=True)
    outputs = {}
    mode = job.get("mode", "track")
    if mode == "vocal":
        if job.get("vocals", True):
            p = os.path.join(outdir, "vocals.wav")
            save_wav(p, stems["vocals"], sr)
            outputs["vocals"] = p
        if job.get("instrumental", True):
            inst = sum(v for k, v in stems.items() if k != "vocals")
            p = os.path.join(outdir, "instrumental.wav")
            save_wav(p, inst, sr)
            outputs["instrumental"] = p
    else:
        keep = job.get("stems") or sources
        for name in sources:
            if name in keep:
                p = os.path.join(outdir, f"{name}.wav")
                save_wav(p, stems[name], sr)
                outputs[name] = p
        mix = [s for s in (job.get("mix") or []) if s in stems]
        if mix:
            p = os.path.join(outdir, "mix.wav")
            save_wav(p, sum(stems[s] for s in mix), sr)
            outputs["mix"] = p
    progress(1.0, "완료")
    emit(type="result", outputs=outputs, sources=sources)


# ──────────────────────────────────────────────── 키 · 템포 (Rubber Band)
def task_stretch(job):
    import numpy as np
    from pedalboard import time_stretch

    progress(0.0, "음원 불러오는 중")
    audio, sr = load_wav(job["input"])
    rate = float(job.get("rate", 1.0))
    semis = float(job.get("semitones", 0.0))
    if not job.get("keep_pitch", True) and rate != 1.0:
        semis += 12.0 * math.log2(rate)  # 레코드판처럼 빨라지면 음도 높아짐
    formants = bool(job.get("formants", True))
    label = job.get("label", "처리하는 중")

    def run(x):
        return time_stretch(x, sr, stretch_factor=rate, pitch_shift_in_semitones=semis,
                            high_quality=True, preserve_formants=formants)

    total_sec = audio.shape[1] / sr
    # 앞부분 몇 초로 속도를 재서 남은 시간을 예측합니다
    probe_len = int(min(total_sec, 8.0) * sr)
    t0 = time.time()
    if probe_len > sr:
        run(np.ascontiguousarray(audio[:, :probe_len]))
    speed = (time.time() - t0) / max(0.5, probe_len / sr)
    predicted = max(1.0, speed * total_sec * 1.15)

    done = threading.Event()

    def ticker():
        start = time.time()
        while not done.wait(0.4):
            frac = (time.time() - start) / predicted
            progress(0.05 + 0.85 * (1 - math.exp(-2.2 * frac)), label)

    th = threading.Thread(target=ticker, daemon=True)
    th.start()
    try:
        out = run(np.ascontiguousarray(audio))
    finally:
        done.set()
        th.join()
    progress(0.93, "파일로 저장하는 중")
    save_wav(job["output"], out.astype("float32"), sr)
    progress(1.0, "완료")
    emit(type="result", outputs={"output": job["output"]})


def main():
    if len(sys.argv) < 2:
        emit(type="error", message="작업 정보가 없어요")
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    task = job.get("task")
    try:
        if task == "check":
            task_check(job)
        elif task == "separate":
            task_separate(job)
        elif task == "stretch":
            task_stretch(job)
        else:
            emit(type="error", message=f"알 수 없는 작업: {task}")
            return 2
    except MemoryError:
        emit(type="error", message="메모리가 부족해요. 다른 앱을 닫거나 더 짧은 곡으로 시도해 주세요.")
        return 1
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit(type="error", message=str(e) or e.__class__.__name__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
