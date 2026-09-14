"""
Geometria de gabarito: do pixel ao plano da via.

Esta e a parte do pipeline de borda que nao depende do detector e que, na
pratica, decide se o sistema funciona. Um detector pode dizer "ha um automovel
no quadro"; isso nao e util. O que o CCO precisa saber e se o objeto esta DENTRO
do gabarito dinamico, e a que distancia lateral do eixo da via - e isso e
geometria, nao aprendizado.

A camera do toten e fixa, entao uma homografia unica mapeia o plano da imagem no
plano da via. Quatro pontos de referencia levantados na instalacao bastam: na
pratica, marcos pintados no pavimento cujas coordenadas sao medidas com trena.

Trocar o detector nao muda nada aqui. Por isso a homografia e a decisao de
gabarito ficam separadas da inferencia - a Fase 2 substitui o backend por
TensorRT no Orin sem tocar nesta camada.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Vossloh Tramlink V4: caixa de 2,65 m. O gabarito DINAMICO acrescenta a
# envoltoria de balanco (suspensao, curva, vento) - a norma de projeto do VLT
# adota folga lateral adicional de 0,30 m por lado.
CAR_BODY_WIDTH_M = 2.65
DYNAMIC_ENVELOPE_M = 0.30
HALF_GAUGE_M = CAR_BODY_WIDTH_M / 2 + DYNAMIC_ENVELOPE_M  # 1,625 m


@dataclass(frozen=True)
class CameraCalibration:
    """Calibracao do toten: 4 pontos imagem <-> 4 pontos no plano da via.

    image_pts: pixels (x, y), sentido horario a partir do canto proximo-esquerdo
    track_pts: metros (lateral, longitudinal) no referencial da via, com
               lateral = 0 no eixo e longitudinal crescendo no sentido de marcha
    """

    image_pts: np.ndarray
    track_pts: np.ndarray
    frame_w: int
    frame_h: int

    @staticmethod
    def default_totem(frame_w: int = 960, frame_h: int = 540) -> "CameraCalibration":
        """Calibracao tipica de toten em cruzamento, camera a ~4,5 m de altura."""
        image_pts = np.float32([
            [180, 520],   # canto proximo esquerdo
            [780, 520],   # canto proximo direito
            [590, 250],   # canto distante direito
            [380, 250],   # canto distante esquerdo
        ])
        track_pts = np.float32([
            [-4.0, 2.0],
            [4.0, 2.0],
            [4.0, 30.0],
            [-4.0, 30.0],
        ])
        return CameraCalibration(image_pts, track_pts, frame_w, frame_h)


class GaugeProjector:
    """Projeta pontos da imagem no plano da via e decide invasao de gabarito."""

    def __init__(self, calib: CameraCalibration) -> None:
        import cv2

        self.calib = calib
        self._H = cv2.getPerspectiveTransform(calib.image_pts, calib.track_pts)
        self._H_inv = cv2.getPerspectiveTransform(calib.track_pts, calib.image_pts)

    def image_to_track(self, x: float, y: float) -> tuple[float, float]:
        """Pixel -> (lateral_m, longitudinal_m) no plano da via."""
        p = np.array([x, y, 1.0], dtype=np.float64)
        q = self._H @ p
        if abs(q[2]) < 1e-9:
            return (float("inf"), float("inf"))
        return float(q[0] / q[2]), float(q[1] / q[2])

    def track_to_image(self, lateral_m: float, longitudinal_m: float) -> tuple[int, int]:
        """(lateral_m, longitudinal_m) -> pixel. Usado pelo gerador de cena."""
        p = np.array([lateral_m, longitudinal_m, 1.0], dtype=np.float64)
        q = self._H_inv @ p
        if abs(q[2]) < 1e-9:
            return (0, 0)
        return int(round(q[0] / q[2])), int(round(q[1] / q[2]))

    def gauge_margin_m(self, lateral_m: float) -> float:
        """Folga ate o gabarito. Negativo = ja dentro.

        O ponto de referencia e a borda do objeto mais proxima do eixo, nao seu
        centro: um caminhao cujo centro esta fora do gabarito mas cuja lateral
        invade continua sendo colisao.
        """
        return abs(lateral_m) - HALF_GAUGE_M

    def footprint_lateral_m(self, bbox: tuple[int, int, int, int]) -> tuple[float, float]:
        """Extensao lateral do objeto no plano da via, a partir da bbox.

        Usa a BASE da caixa (y2), nao o centro: o contato do objeto com o solo e
        o unico ponto cuja projecao pela homografia e valida. Projetar o centro
        de um objeto alto o coloca sistematicamente mais longe do que esta - erro
        que cresce com a altura e que, num caminhao, chega a metros.
        """
        x1, _y1, x2, y2 = bbox
        left, _ = self.image_to_track(x1, y2)
        right, _ = self.image_to_track(x2, y2)
        return (min(left, right), max(left, right))

    def nearest_lateral_m(self, bbox: tuple[int, int, int, int]) -> float:
        """Distancia lateral da borda do objeto mais proxima do eixo da via."""
        lo, hi = self.footprint_lateral_m(bbox)
        if lo <= 0.0 <= hi:
            return 0.0  # objeto cruza o eixo
        return min(abs(lo), abs(hi))

    def longitudinal_m(self, bbox: tuple[int, int, int, int]) -> float:
        x1, _y1, x2, y2 = bbox
        _, lon = self.image_to_track((x1 + x2) / 2, y2)
        return lon
