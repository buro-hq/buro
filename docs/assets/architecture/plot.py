# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""Regenerate the architecture page's measured example: uv run docs/assets/architecture/plot.py."""

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

directory = Path(__file__).resolve().parent
data = json.loads((directory / "rtx-sample.json").read_text())
samples = data["samples"]
labels = ["Qwen 9B", "Qwen 35B MoE"]
colors = ["#4563b7", "#227a79"]

with plt.rc_context({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "path", "svg.hashsalt": "buro-architecture-rtx-v1"}):
    figure, axes = plt.subplots(1, 2, figsize=(10.8, 3.5), layout="constrained")
    figure.set_facecolor("#ffffff")
    figure.suptitle("Одна задача, thinking, RTX 3060 12 ГБ", fontsize=15, weight="bold")

    for axis, field, title, limit in [
        (axes[0], "wallSeconds", "Полное время задачи, с\nМеньше лучше", 85),
        (axes[1], "decodeTokensPerSecond", "Генерация, токенов/с\nБольше лучше", 70),
    ]:
        values = [sample[field] for sample in samples]
        axis.barh(labels, values, color=colors, height=0.48, zorder=3)
        axis.invert_yaxis()
        axis.set_xlim(0, limit)
        axis.set_title(title, fontsize=10, pad=14)
        axis.grid(axis="x", color="#e5e8f0", zorder=0)
        axis.tick_params(axis="both", length=0, pad=8)
        axis.spines[["top", "right", "left"]].set_visible(False)
        axis.spines["bottom"].set_color("#d8ddea")
        for position, value in enumerate(values):
            axis.text(value + 1, position, f"{value:.1f}", va="center", weight="bold")

    figure.supxlabel("8/8 проверок у обеих моделей; один прогон на модель, без ревьюера", fontsize=10)
    figure.savefig(directory / "rtx-sample.svg", metadata={"Date": None})
    plt.close(figure)

svg = directory / "rtx-sample.svg"
svg.write_text("\n".join(line.rstrip() for line in svg.read_text().splitlines()) + "\n")
