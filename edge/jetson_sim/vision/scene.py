"""
Gerador de cena sintetica com ground truth.

Renderiza um cruzamento visto do toten, com objetos posicionados em coordenadas
CONHECIDAS do plano da via e projetados na imagem pela homografia inversa. Como
a posicao verdadeira e conhecida por construcao, o erro de localizacao do
pipeline pode ser medido - e nao apenas inspecionado visualmente.

Isso e o que distingue este gerador de um video de demonstracao: ele produz
metrica. Sem ground truth, "o pipeline detectou o carro" e uma afirmacao sem
numero atras; com ela, da para dizer que o erro lateral mediano e de X cm, que e
o que decide se o limiar de gabarito de 1,625 m e utilizavel.

Nao substitui dado de campo. Iluminacao, chuva, textura de pavimento e oclusao
real so vem da Fase 2. O que se valida aqui e a cadeia geometrica.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import GaugeProjector, HALF_GAUGE_M


@dataclass
class GroundTruthObject:
    obj_id: str
    cls: str
    lateral_m: float
    longitudinal_m: float
    width_m: float
    height_m: float

    @property
    def nearest_lateral_m(self) -> float:
        half = self.width_m / 2
        lo, hi = self.lateral_m - half, self.lateral_m + half
        if lo <= 0.0 <= hi:
            return 0.0
        return min(abs(lo), abs(hi))

    @property
    def gauge_margin_m(self) -> float:
        return self.nearest_lateral_m - HALF_GAUGE_M


class SceneRenderer:
    """Desenha o corredor da via e os objetos, em perspectiva."""

    def __init__(self, projector: GaugeProjector, w: int = 960, h: int = 540) -> None:
        self.p = projector
        self.w, self.h = w, h
        self._bg = self._make_background()

    def _make_background(self) -> np.ndarray:
        img = np.full((self.h, self.w, 3), 78, dtype=np.uint8)
        # Pavimento em perspectiva
        road = np.array([
            self.p.track_to_image(-6.0, 2.0), self.p.track_to_image(6.0, 2.0),
            self.p.track_to_image(6.0, 34.0), self.p.track_to_image(-6.0, 34.0),
        ], dtype=np.int32)
        cv2.fillPoly(img, [road], (96, 96, 99))
        # Trilhos: duas linhas a +-0,7175 m (bitola 1435 mm)
        for lat in (-0.7175, 0.7175):
            pts = [self.p.track_to_image(lat, lon) for lon in np.linspace(2.0, 34.0, 40)]
            cv2.polylines(img, [np.array(pts, dtype=np.int32)], False, (150, 150, 155), 3)
        # Textura de pavimento, para dar ao subtrator de fundo algo real
        rng = np.random.default_rng(7)
        noise = rng.integers(-9, 9, (self.h, self.w, 1), dtype=np.int16)
        img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        return img

    def bbox_for(self, o: GroundTruthObject) -> tuple[int, int, int, int]:
        """Caixa que o renderizador desenha para este objeto.

        Exposta para que o banco pareie deteccao com verdade por IoU, e nao por
        proximidade de coordenada. Parear por distancia longitudinal associava o
        pedestre ao automovel quando ambos caiam na mesma janela, e o erro de
        ASSOCIACAO aparecia no relatorio como erro de LOCALIZACAO.
        """
        half = o.width_m / 2
        base_l = self.p.track_to_image(o.lateral_m - half, o.longitudinal_m)
        base_r = self.p.track_to_image(o.lateral_m + half, o.longitudinal_m)
        top_l = self.p.track_to_image(o.lateral_m - half, o.longitudinal_m + o.height_m * 0.35)
        px_h = int(abs(base_l[1] - top_l[1]) + o.height_m * 14)
        x1, x2 = min(base_l[0], base_r[0]), max(base_l[0], base_r[0])
        y2 = max(base_l[1], base_r[1])
        y1 = y2 - max(12, px_h)
        return (x1, y1, x2, y2)

    def render(self, objects: list[GroundTruthObject], jitter_seed: int = 0) -> np.ndarray:
        img = self._bg.copy()
        # Ruido temporal: sensor real nunca entrega dois quadros identicos, e um
        # fundo perfeitamente estatico tornaria a subtracao irrealisticamente boa.
        rng = np.random.default_rng(jitter_seed)
        img = np.clip(img.astype(np.int16) + rng.integers(-4, 4, img.shape, dtype=np.int16), 0, 255).astype(np.uint8)

        # Desenha do mais distante ao mais proximo, para oclusao correta.
        for o in sorted(objects, key=lambda x: -x.longitudinal_m):
            half = o.width_m / 2
            base_l = self.p.track_to_image(o.lateral_m - half, o.longitudinal_m)
            base_r = self.p.track_to_image(o.lateral_m + half, o.longitudinal_m)
            # Altura projetada: aproximada pela escala da base
            top_l = self.p.track_to_image(o.lateral_m - half, o.longitudinal_m + o.height_m * 0.35)
            px_h = int(abs(base_l[1] - top_l[1]) + o.height_m * 14)
            color = {"car": (52, 64, 168), "truck": (60, 110, 60), "person": (200, 170, 120)}.get(o.cls, (140, 140, 140))
            x1, x2 = min(base_l[0], base_r[0]), max(base_l[0], base_r[0])
            y2 = max(base_l[1], base_r[1])
            y1 = y2 - max(12, px_h)
            cv2.rectangle(img, (x1, y1), (x2, y2), color, -1)
            cv2.rectangle(img, (x1, y1), (x2, y2), (20, 20, 20), 2)
        return img

    def overlay_gauge(self, img: np.ndarray) -> np.ndarray:
        """Desenha o gabarito dinamico - util para inspecao visual."""
        out = img.copy()
        for lat in (-HALF_GAUGE_M, HALF_GAUGE_M):
            pts = [self.p.track_to_image(lat, lon) for lon in np.linspace(2.0, 34.0, 40)]
            cv2.polylines(out, [np.array(pts, dtype=np.int32)], False, (0, 200, 255), 2)
        return out


def intrusion_sequence(n_frames: int = 90) -> list[list[GroundTruthObject]]:
    """Cenario: automovel cruza a via e para sobre o gabarito.

    Comeca fora (lateral 5,2 m), avanca ate parar invadindo (lateral 0,4 m) e
    permanece. Reproduz a ocorrencia real que motiva o sistema: veiculo retido
    sobre a via por congestionamento no cruzamento.
    """
    frames: list[list[GroundTruthObject]] = []
    for i in range(n_frames):
        # Aproximacao ate o quadro 45, depois imobilizado.
        t = min(i / 45.0, 1.0)
        lateral = 5.2 - t * 4.8
        car = GroundTruthObject("car-1", "car", lateral_m=lateral, longitudinal_m=12.0, width_m=1.8, height_m=1.5)
        objs = [car]
        # Pedestre na calcada, sempre fora do gabarito: serve de controle
        # negativo - se o pipeline o marcar como invasao, ha falso positivo.
        if i > 20:
            objs.append(GroundTruthObject("ped-1", "person", lateral_m=-4.6, longitudinal_m=8.0 + (i - 20) * 0.05, width_m=0.6, height_m=1.7))
        frames.append(objs)
    return frames
