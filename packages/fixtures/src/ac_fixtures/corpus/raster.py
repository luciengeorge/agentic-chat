"""Paper copies: rendered pages rasterised, then given seeded scanner or paper artefacts."""

import hashlib
import io
from dataclasses import dataclass
from typing import Any

import numpy as np
import pypdfium2 as pdfium  # pyright: ignore[reportMissingTypeStubs]
from PIL import Image, ImageFilter

DPI = 200


@dataclass(frozen=True)
class Wear:
    skew: float  # max degrees either way
    blur: tuple[float, float]  # Gaussian radius, px
    noise: float  # Gaussian sigma, grey levels
    speckle: float  # share of pixels hit by dust
    shading: float  # grey levels of uneven lighting across the page
    quality: tuple[int, int]  # JPEG quality


SCANNER = Wear(skew=1.4, blur=(0.6, 1.0), noise=8.0, speckle=0.0004, shading=14.0, quality=(45, 65))
PAPER = Wear(skew=0.6, blur=(0.3, 0.5), noise=4.0, speckle=0.00005, shading=6.0, quality=(70, 80))


def copies(pdf: bytes, wear: Wear, seed: str) -> tuple[bytes, ...]:
    """Every page of `pdf` as a worn JPEG. Page n's artefacts are seeded by `seed` and n."""
    document: Any = pdfium.PdfDocument(pdf)
    try:
        pages: list[bytes] = []
        for number, page in enumerate(document, start=1):
            bitmap = page.render(scale=DPI / 72, grayscale=True)
            image: Image.Image = bitmap.to_pil().convert("L")
            pages.append(_worn(image, wear, _rng(seed, number)))
            page.close()
        return tuple(pages)
    finally:
        document.close()


def _rng(seed: str, page: int) -> np.random.Generator:
    digest = hashlib.sha256(f"{seed}:{page}".encode()).digest()
    return np.random.default_rng(int.from_bytes(digest[:8], "big"))


def _worn(image: Image.Image, wear: Wear, rng: np.random.Generator) -> bytes:
    paper = float(rng.uniform(236, 248))
    angle = float(rng.uniform(-wear.skew, wear.skew))
    image = image.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=255)
    image = image.filter(ImageFilter.GaussianBlur(float(rng.uniform(*wear.blur))))

    ink = np.asarray(image, dtype=np.float64)
    height, width = ink.shape
    pixels = ink * (paper / 255.0)
    # Light falls off from one side of the platen.
    dx, dy = rng.uniform(-1, 1, size=2)
    xs = np.linspace(-1.0, 1.0, width)[None, :]
    ys = np.linspace(-1.0, 1.0, height)[:, None]
    pixels -= wear.shading * (0.5 + 0.5 * (dx * xs + dy * ys))
    pixels += rng.normal(0.0, wear.noise, size=pixels.shape)
    dust = int(height * width * wear.speckle)
    rows = rng.integers(0, height - 1, size=dust)
    cols = rng.integers(0, width - 1, size=dust)
    shade = rng.uniform(20, 110, size=dust)
    for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)):
        pixels[rows + dr, cols + dc] = shade

    worn = Image.fromarray(np.clip(np.rint(pixels), 0, 255).astype(np.uint8), mode="L")
    out = io.BytesIO()
    quality = int(rng.integers(wear.quality[0], wear.quality[1] + 1))
    worn.save(out, "JPEG", quality=quality, dpi=(DPI, DPI), optimize=False, progressive=False)
    return out.getvalue()
