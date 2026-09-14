"""
Rastreio temporal de objetos.

Existe por dois motivos que o detector sozinho nao resolve:

1. PERSISTENCIA. O filtro do ats-core exige que a condicao dure alem de um
   quadro. Sem id estavel entre quadros nao ha como medir duracao - cada quadro
   pareceria um objeto novo.

2. DEDUPLICACAO. Um automovel parado sobre a via gera deteccao em todo quadro.
   Sem rastreio, seriam 30 alertas por segundo para a mesma ocorrencia, e o
   operador perderia o evento no ruido que o proprio sistema criou.

Associacao por IoU com histerese: um objeto perdido por alguns quadros (oclusao
por outro veiculo, por exemplo) mantem o id ao reaparecer. Sem isso a oclusao
reiniciaria o contador de persistencia e a invasao voltaria ao estado inicial no
pior momento possivel.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .detector import Detection


def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / float(area_a + area_b - inter)


@dataclass
class Track:
    track_id: str
    bbox: tuple[int, int, int, int]
    cls: str
    confidence: float
    first_seen: float
    last_seen: float
    hits: int = 1
    misses: int = 0
    # Historico de classes, para estabilizar a classificacao por votacao.
    cls_votes: dict[str, int] = field(default_factory=dict)

    @property
    def dwell_ms(self) -> int:
        return int((self.last_seen - self.first_seen) * 1000)


class Tracker:
    def __init__(self, iou_threshold: float = 0.3, max_misses: int = 8) -> None:
        self._tracks: dict[str, Track] = {}
        self._next = 1
        self._iou_t = iou_threshold
        self._max_misses = max_misses

    def update(self, detections: list[Detection], now: float | None = None) -> list[Track]:
        now = now if now is not None else time.time()
        unmatched = list(detections)

        for tr in self._tracks.values():
            best, best_iou = None, self._iou_t
            for det in unmatched:
                v = iou(tr.bbox, det.bbox)
                if v >= best_iou:
                    best, best_iou = det, v
            if best is not None:
                unmatched.remove(best)
                tr.bbox = best.bbox
                tr.confidence = best.confidence
                tr.last_seen = now
                tr.hits += 1
                tr.misses = 0
                tr.cls_votes[best.cls] = tr.cls_votes.get(best.cls, 0) + 1
                # Classe por votacao acumulada: um quadro isolado classificando
                # mal nao reescreve a identidade do objeto.
                tr.cls = max(tr.cls_votes.items(), key=lambda kv: kv[1])[0]
            else:
                tr.misses += 1

        for det in unmatched:
            tid = f"t-{self._next:04d}"
            self._next += 1
            self._tracks[tid] = Track(
                track_id=tid, bbox=det.bbox, cls=det.cls, confidence=det.confidence,
                first_seen=now, last_seen=now, cls_votes={det.cls: 1},
            )

        for tid in [t for t, tr in self._tracks.items() if tr.misses > self._max_misses]:
            del self._tracks[tid]

        return list(self._tracks.values())

    @property
    def active(self) -> list[Track]:
        return [t for t in self._tracks.values() if t.misses == 0]
