"""Lightweight local image-change detection for apps without AT-SPI UI events."""
from __future__ import annotations

import io

from PIL import Image, ImageChops


def prepare(png: bytes, region: tuple[int, int, int, int] | None = None,
            max_side: int = 320) -> Image.Image:
    if max_side < 16 or max_side > 1024:
        raise ValueError("max_side must be between 16 and 1024")
    with Image.open(io.BytesIO(png)) as full:
        if region is not None:
            x, y, width, height = region
            if x < 0 or y < 0 or width < 1 or height < 1 or x + width > full.width or y + height > full.height:
                raise ValueError(f"Region {region} is outside {full.width}x{full.height}")
            image = full.crop((x, y, x + width, y + height)).convert("L")
        else:
            image = full.convert("L")
        scale = min(1.0, max_side / max(image.size))
        if scale < 1:
            image = image.resize(
                (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                resample=Image.Resampling.BILINEAR,
            )
        return image


def compare(before: Image.Image, after: Image.Image, pixel_threshold: int = 25) -> dict:
    """Compare downsized grayscale screenshots; no image data leaves this process."""
    if not 0 <= pixel_threshold <= 255:
        raise ValueError("pixel_threshold must be 0..255")
    if before.size != after.size:
        return {"changed_fraction": 1.0, "mean_difference": 255.0, "resolution_changed": True}
    diff = ImageChops.difference(before, after)
    histogram = diff.histogram()
    total = sum(histogram)
    affected = sum(histogram[pixel_threshold + 1:]) if pixel_threshold < 255 else 0
    mean = sum(i * count for i, count in enumerate(histogram)) / max(1, total)
    return {
        "changed_fraction": round(affected / max(1, total), 5),
        "mean_difference": round(mean, 2),
        "resolution_changed": False,
    }
