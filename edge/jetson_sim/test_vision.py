#!/usr/bin/env python3
"""
Testes do pipeline de visao de borda.

Cobrem a cadeia geometrica - que e o que transfere para o hardware real. Os
pesos do detector nao sao testados aqui: so podem ser avaliados com dado de
campo rotulado, que e trabalho da Fase 2.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vision.detector import Detection, MotionDetector  # noqa: E402
from vision.geometry import HALF_GAUGE_M, CameraCalibration, GaugeProjector  # noqa: E402
from vision.pipeline import EdgePipeline  # noqa: E402
from vision.scene import SceneRenderer, intrusion_sequence  # noqa: E402
from vision.tracker import Tracker, iou  # noqa: E402


class TestGeometry(unittest.TestCase):
    def setUp(self) -> None:
        self.p = GaugeProjector(CameraCalibration.default_totem())

    def test_homografia_ida_e_volta(self) -> None:
        """Pixel -> via -> pixel deve fechar com erro sub-centimetrico."""
        for lat, lon in [(0.0, 10.0), (2.5, 15.0), (-4.0, 8.0), (3.0, 28.0)]:
            px = self.p.track_to_image(lat, lon)
            back_lat, back_lon = self.p.image_to_track(*px)
            self.assertLess(abs(back_lat - lat), 0.05, f"erro lateral em ({lat},{lon})")
            self.assertLess(abs(back_lon - lon), 0.10, f"erro longitudinal em ({lat},{lon})")

    def test_gabarito_usa_meia_largura_correta(self) -> None:
        """2,65 m de caixa + 0,30 m de envoltoria por lado."""
        self.assertAlmostEqual(HALF_GAUGE_M, 1.625, places=3)

    def test_margem_negativa_dentro_do_gabarito(self) -> None:
        self.assertLess(self.p.gauge_margin_m(0.5), 0, "0,5 m do eixo esta dentro")
        self.assertGreater(self.p.gauge_margin_m(3.0), 0, "3,0 m do eixo esta fora")
        self.assertAlmostEqual(self.p.gauge_margin_m(HALF_GAUGE_M), 0.0, places=6)

    def test_margem_e_simetrica(self) -> None:
        """Invadir pela esquerda ou pela direita e igualmente grave."""
        self.assertAlmostEqual(self.p.gauge_margin_m(-1.2), self.p.gauge_margin_m(1.2), places=6)

    def test_usa_a_base_da_caixa_nao_o_centro(self) -> None:
        """Projetar o centro de um objeto alto o afasta sistematicamente.

        So o contato com o solo tem projecao valida pela homografia. Este teste
        trava a escolha: duas caixas com a mesma base e alturas diferentes
        precisam produzir a mesma posicao no plano da via.
        """
        baixa = (400, 380, 470, 420)
        alta = (400, 300, 470, 420)  # mesma base, muito mais alta
        self.assertAlmostEqual(
            self.p.nearest_lateral_m(baixa), self.p.nearest_lateral_m(alta), places=6,
            msg="a altura da caixa nao pode alterar a posicao no plano da via",
        )

    def test_borda_mais_proxima_e_nao_o_centro(self) -> None:
        """Um caminhao cujo centro esta fora mas cuja lateral invade e invasao."""
        # Caixa larga cruzando o eixo
        larga = (self.p.track_to_image(-0.5, 12)[0], 300, self.p.track_to_image(3.0, 12)[0], 400)
        self.assertEqual(self.p.nearest_lateral_m(larga), 0.0, "objeto que cruza o eixo tem lateral 0")


class TestTracker(unittest.TestCase):
    def test_id_preservado_entre_quadros(self) -> None:
        t = Tracker()
        t.update([Detection((10, 10, 60, 80), "car", 0.9)], now=0.0)
        tracks = t.update([Detection((14, 12, 64, 82), "car", 0.92)], now=0.5)
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0].track_id, "t-0001")
        self.assertEqual(tracks[0].dwell_ms, 500)

    def test_objeto_distinto_ganha_id_novo(self) -> None:
        t = Tracker()
        t.update([Detection((10, 10, 60, 80), "car", 0.9)], now=0.0)
        tracks = t.update([Detection((500, 300, 560, 380), "person", 0.8)], now=0.1)
        self.assertEqual(len({tr.track_id for tr in tracks}), 2)

    def test_trilha_perdida_e_descartada_apos_limite(self) -> None:
        t = Tracker(max_misses=3)
        t.update([Detection((10, 10, 60, 80), "car", 0.9)], now=0.0)
        for i in range(6):
            t.update([], now=0.1 * (i + 1))
        self.assertEqual(len(t.active), 0)

    def test_classe_por_votacao_resiste_a_quadro_ruim(self) -> None:
        t = Tracker()
        box = (10, 10, 60, 80)
        for i in range(5):
            t.update([Detection(box, "car", 0.9)], now=0.1 * i)
        tracks = t.update([Detection(box, "person", 0.4)], now=0.6)
        self.assertEqual(tracks[0].cls, "car", "um quadro ruim nao reescreve a identidade")

    def test_iou(self) -> None:
        self.assertAlmostEqual(iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(iou((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)


class TestPipeline(unittest.TestCase):
    def setUp(self) -> None:
        self.p = GaugeProjector(CameraCalibration.default_totem())
        self.renderer = SceneRenderer(self.p)
        self.pipe = EdgePipeline(MotionDetector(), self.p)
        for i in range(12):
            self.pipe.process(self.renderer.render([], jitter_seed=i))

    def test_trilha_nao_observada_nao_e_avaliada(self) -> None:
        """Bug real: a trilha mantinha a caixa antiga e a geometria era avaliada
        sobre ela, reportando a posicao que o objeto ocupava e nao a atual.
        Numa deteccao de invasao isso manda o operador procurar no lugar errado.
        """
        frames = intrusion_sequence(40)
        self.pipe.process(self.renderer.render(frames[0], jitter_seed=100))
        # Cena vazia: nenhuma deteccao, mas a trilha sobrevive alguns quadros.
        res = self.pipe.process(self.renderer.render([], jitter_seed=101))
        self.assertEqual(len(res.assessments), 0, "trilha em coasting nao pode ser avaliada")
        self.assertGreaterEqual(res.coasting_tracks, 0)

    def test_detecta_a_invasao(self) -> None:
        frames = intrusion_sequence(90)
        detected = None
        for idx, objs in enumerate(frames):
            res = self.pipe.process(self.renderer.render(objs, jitter_seed=100 + idx), now=idx / 30.0)
            if res.intrusions and detected is None:
                detected = idx
        self.assertIsNotNone(detected, "a invasao precisa ser detectada")
        assert detected is not None
        self.assertLess(detected, 45, "deteccao tardia demais")

    def test_pedestre_na_calcada_nao_gera_invasao(self) -> None:
        """Controle negativo: objeto sempre fora do gabarito."""
        from vision.scene import GroundTruthObject
        ped = GroundTruthObject("p", "person", lateral_m=-4.6, longitudinal_m=10.0, width_m=0.6, height_m=1.7)
        self.assertGreater(ped.gauge_margin_m, 0, "o cenario precisa manter o pedestre fora")
        for i in range(30):
            res = self.pipe.process(self.renderer.render([ped], jitter_seed=200 + i), now=i / 30.0)
            for a in res.intrusions:
                self.fail(f"falso positivo no quadro {i}: {a}")

    def test_fora_do_alcance_calibrado_e_descartado(self) -> None:
        """Extrapolar a homografia produz posicao que a calibracao nao sustenta."""
        pipe = EdgePipeline(MotionDetector(), self.p, max_range_m=15.0)
        from vision.scene import GroundTruthObject
        longe = GroundTruthObject("c", "car", lateral_m=0.0, longitudinal_m=30.0, width_m=1.8, height_m=1.5)
        for i in range(12):
            pipe.process(self.renderer.render([], jitter_seed=i))
        for i in range(10):
            res = pipe.process(self.renderer.render([longe], jitter_seed=300 + i), now=i / 30.0)
            for a in res.assessments:
                self.assertLessEqual(a.longitudinal_m, 15.0)

    def test_orcamento_de_latencia(self) -> None:
        """33 ms e o teto para sustentar 30 fps."""
        for idx, objs in enumerate(intrusion_sequence(60)):
            self.pipe.process(self.renderer.render(objs, jitter_seed=100 + idx), now=idx / 30.0)
        stats = self.pipe.latency_stats()
        self.assertLess(stats["p95_ms"], 33.0, f"p95 de {stats['p95_ms']}ms estoura o orcamento")


if __name__ == "__main__":
    unittest.main(verbosity=2)
