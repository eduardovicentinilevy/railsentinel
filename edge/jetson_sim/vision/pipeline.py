"""
Pipeline de inferencia de borda - orquestracao e orcamento de latencia.

Cadeia: quadro -> deteccao -> rastreio -> projecao no plano da via -> decisao de
gabarito -> evento.

O orcamento de latencia e requisito de projeto, nao metrica de vaidade. A 25
km/h uma composicao percorre 6,9 m por segundo; cada 100 ms de atraso na cadeia
custa 0,7 m de distancia de reacao. O alvo do projeto - 30 fps com folga - exige
que a cadeia inteira feche em menos de 33 ms, e o relatorio quebra o tempo por
estagio para que o gargalo seja visivel quando nao fechar.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np

from .detector import Detector, Detection, timed_detect
from .geometry import GaugeProjector
from .tracker import Track, Tracker


@dataclass
class IntrusionAssessment:
    track_id: str
    cls: str
    confidence: float
    bbox: tuple[int, int, int, int]
    lateral_m: float
    longitudinal_m: float
    gauge_margin_m: float
    dwell_ms: int
    intruding: bool


@dataclass
class FrameResult:
    frame_index: int
    detections: int
    assessments: list[IntrusionAssessment]
    latency_ms: dict[str, float] = field(default_factory=dict)
    #: Trilhas vivas porem nao observadas neste quadro (oclusao ou perda).
    coasting_tracks: int = 0

    @property
    def total_ms(self) -> float:
        return sum(self.latency_ms.values())

    @property
    def intrusions(self) -> list[IntrusionAssessment]:
        return [a for a in self.assessments if a.intruding]


class EdgePipeline:
    def __init__(self, detector: Detector, projector: GaugeProjector, *, max_range_m: float = 34.0) -> None:
        self.detector = detector
        self.projector = projector
        self.tracker = Tracker()
        self._frame = 0
        self._max_range_m = max_range_m
        self.latency_history: list[float] = []

    def process(self, frame: np.ndarray, now: float | None = None) -> FrameResult:
        now = now if now is not None else time.time()
        lat: dict[str, float] = {}

        detections, det_ms = timed_detect(self.detector, frame)
        lat["detect"] = det_ms

        t0 = time.perf_counter()
        tracks = self.tracker.update(detections, now=now)
        lat["track"] = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        # Somente trilhas OBSERVADAS neste quadro sao avaliadas.
        #
        # Uma trilha nao casada mantem a ultima caixa conhecida, para preservar
        # o id atraves de oclusao curta. Avaliar essa caixa seria reportar a
        # posicao que o objeto ocupava, nao a que ocupa - e numa deteccao de
        # invasao isso e o pior tipo de erro: o alerta sai com coordenada
        # desatualizada, e o operador procura o obstaculo no lugar errado.
        #
        # A continuidade de id continua valendo para o calculo de persistencia;
        # o que nao vale e a GEOMETRIA de uma trilha que ninguem viu agora.
        current = [tr for tr in tracks if tr.misses == 0]
        assessments = [a for a in (self._assess(tr) for tr in current) if a is not None]
        lat["geometry"] = (time.perf_counter() - t0) * 1000

        self._frame += 1
        result = FrameResult(self._frame, len(detections), assessments, lat,
                             len(tracks) - len(current))
        self.latency_history.append(result.total_ms)
        return result

    def _assess(self, tr: Track) -> IntrusionAssessment | None:
        lon = self.projector.longitudinal_m(tr.bbox)
        # Fora do alcance calibrado a homografia extrapola e o erro explode.
        # Descartar e mais honesto que reportar posicao que a calibracao nao
        # sustenta - um alerta com posicao errada e pior que nenhum alerta.
        if not (0.0 < lon <= self._max_range_m):
            return None

        lateral = self.projector.nearest_lateral_m(tr.bbox)
        margin = self.projector.gauge_margin_m(lateral)
        return IntrusionAssessment(
            track_id=tr.track_id, cls=tr.cls, confidence=tr.confidence, bbox=tr.bbox,
            lateral_m=round(lateral, 3), longitudinal_m=round(lon, 2),
            gauge_margin_m=round(margin, 3), dwell_ms=tr.dwell_ms,
            intruding=margin < 0.0,
        )

    def latency_stats(self) -> dict[str, float]:
        if not self.latency_history:
            return {}
        xs = sorted(self.latency_history)
        n = len(xs)
        return {
            "frames": n,
            "mean_ms": round(sum(xs) / n, 2),
            "p50_ms": round(xs[n // 2], 2),
            "p95_ms": round(xs[min(n - 1, int(n * 0.95))], 2),
            "p99_ms": round(xs[min(n - 1, int(n * 0.99))], 2),
            "max_ms": round(xs[-1], 2),
            "fps_at_p95": round(1000 / max(0.01, xs[min(n - 1, int(n * 0.95))]), 1),
        }
