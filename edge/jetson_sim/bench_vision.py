#!/usr/bin/env python3
"""
Banco do pipeline de inferencia - marco da Fase 1.

Roda a cadeia completa sobre pixels reais com ground truth conhecido e reporta:
  - latencia por estagio e percentis (orcamento de 33 ms para 30 fps)
  - erro de localizacao lateral contra a verdade geometrica
  - deteccao da invasao: acerta, e quando
  - falso positivo no controle negativo (pedestre sempre fora do gabarito)

Uso:  python3 edge/jetson_sim/bench_vision.py [--json saida.json]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vision.detector import build_detector, MotionDetector, OnnxDetector  # noqa: E402
from vision.geometry import CameraCalibration, GaugeProjector, HALF_GAUGE_M  # noqa: E402
from vision.pipeline import EdgePipeline  # noqa: E402
from vision.scene import SceneRenderer, intrusion_sequence  # noqa: E402
from vision.tracker import iou  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="docs/visao-report.json")
    # Mesma razao do banco de estabilidade: verificar e rotineiro, regerar o
    # artefato de evidencia e deliberado. Sem isso, toda checagem sujava a
    # arvore com latencias que variam com a carga da maquina.
    ap.add_argument("--write", action="store_true", help="regrava o relatorio JSON")
    ap.add_argument("--frames", type=int, default=90)
    args = ap.parse_args()

    calib = CameraCalibration.default_totem()
    projector = GaugeProjector(calib)
    renderer = SceneRenderer(projector)
    detector = build_detector()
    pipeline = EdgePipeline(detector, projector)

    backend = detector.name
    provider = getattr(detector, "provider", "n/a")

    print("═══ BANCO DO PIPELINE DE INFERENCIA — Fase 1 ═══\n")
    print(f"  backend: {backend} v{detector.version}   provider: {provider}")
    if isinstance(detector, MotionDetector):
        print("  NOTA: backend de movimento. A latencia medida NAO representa TensorRT no Orin;")
        print("        define RAILSENTINEL_ONNX_MODEL para exercitar o caminho ONNX.\n")

    truth_frames = intrusion_sequence(args.frames)

    # Aquecimento: o subtrator de fundo precisa aprender a cena estatica, e o
    # ONNX Runtime aloca arenas no primeiro forward. Medir sem aquecer mistura
    # custo de inicializacao com custo de regime.
    for i in range(12):
        pipeline.process(renderer.render([], jitter_seed=i))
    pipeline.latency_history.clear()

    lateral_errors: list[float] = []
    first_intrusion_frame: int | None = None
    truth_first_intrusion: int | None = None
    false_positives = 0
    unmatched_tracks: set[str] = set()
    frames_out = []

    for idx, objs in enumerate(truth_frames):
        img = renderer.render(objs, jitter_seed=100 + idx)
        res = pipeline.process(img, now=idx / 30.0)

        car = next((o for o in objs if o.cls == "car"), None)
        if car and truth_first_intrusion is None and car.gauge_margin_m < 0:
            truth_first_intrusion = idx

        for a in res.assessments:
            # Pareamento por IoU contra a caixa que o renderizador desenhou.
            # Associar por proximidade de coordenada misturava pedestre e
            # automovel quando caiam na mesma janela longitudinal, e o erro de
            # associacao contaminava a metrica de localizacao.
            best, best_iou = None, 0.25
            for o in objs:
                v = iou(a.bbox, renderer.bbox_for(o))
                if v > best_iou:
                    best, best_iou = o, v
            if best is not None:
                lateral_errors.append(abs(a.lateral_m - best.nearest_lateral_m))
                unmatched_tracks.discard(a.track_id)
                # Controle negativo: pedestre na calcada nunca deve acusar invasao.
                if best.cls == "person" and a.intruding:
                    false_positives += 1

        if res.intrusions and first_intrusion_frame is None:
            first_intrusion_frame = idx

        frames_out.append({
            "frame": idx, "detections": res.detections,
            "intrusions": len(res.intrusions), "total_ms": round(res.total_ms, 2),
        })

    stats = pipeline.latency_stats()
    lateral_errors.sort()
    med = lateral_errors[len(lateral_errors) // 2] if lateral_errors else float("nan")
    p95 = lateral_errors[min(len(lateral_errors) - 1, int(len(lateral_errors) * 0.95))] if lateral_errors else float("nan")

    print("1) LATENCIA DA CADEIA (orcamento: 33 ms para 30 fps)")
    print(f"   media {stats['mean_ms']}ms | p50 {stats['p50_ms']}ms | p95 {stats['p95_ms']}ms | p99 {stats['p99_ms']}ms | max {stats['max_ms']}ms")
    print(f"   taxa sustentavel no p95: {stats['fps_at_p95']} fps")
    budget_ok = stats["p95_ms"] < 33.0
    print(f"   {'✅' if budget_ok else '❌'} orcamento {'atendido' if budget_ok else 'ESTOURADO'}\n")

    print("2) ACURACIA DE LOCALIZACAO (contra ground truth geometrico)")
    print(f"   erro lateral mediano: {med*100:.1f} cm | p95: {p95*100:.1f} cm")
    print(f"   meia-largura do gabarito: {HALF_GAUGE_M*100:.0f} cm")
    accuracy_ok = p95 < HALF_GAUGE_M * 0.25
    print(f"   {'✅' if accuracy_ok else '❌'} erro p95 {'abaixo' if accuracy_ok else 'ACIMA'} de 25% da meia-largura\n")

    print("3) DETECCAO DA INVASAO")
    print(f"   invasao real comeca no quadro: {truth_first_intrusion}")
    print(f"   pipeline acusa no quadro:      {first_intrusion_frame}")
    lag = (first_intrusion_frame - truth_first_intrusion) if (first_intrusion_frame is not None and truth_first_intrusion is not None) else None
    if lag is not None:
        print(f"   atraso de deteccao: {lag} quadros ({lag/30*1000:.0f} ms a 30 fps)")
    detected_ok = first_intrusion_frame is not None and lag is not None and lag <= 15
    print(f"   {'✅' if detected_ok else '❌'} {'invasao detectada a tempo' if detected_ok else 'FALHA na deteccao'}\n")

    print("4) CONTROLE NEGATIVO (pedestre na calcada, sempre fora do gabarito)")
    print(f"   falsos positivos: {false_positives}")
    fp_ok = false_positives == 0
    print(f"   {'✅' if fp_ok else '❌'}\n")

    verdict = budget_ok and accuracy_ok and detected_ok and fp_ok
    print("═══ VEREDITO ═══")
    print(f"   {'✅ PIPELINE VALIDADO EM BANCADA' if verdict else '❌ NAO VALIDADO'}")
    print("   Ressalva: cena sintetica. Iluminacao, chuva, oclusao real e textura")
    print("   de pavimento so se validam com dado de campo (Fase 2).\n")

    report = {
        "backend": backend, "version": detector.version, "provider": provider,
        "latency": stats,
        "localization": {"median_error_cm": round(med * 100, 2), "p95_error_cm": round(p95 * 100, 2), "half_gauge_cm": HALF_GAUGE_M * 100},
        "intrusion": {"truth_frame": truth_first_intrusion, "detected_frame": first_intrusion_frame, "lag_frames": lag},
        "false_positives": false_positives,
        "verdict": "VALIDATED" if verdict else "NOT_VALIDATED",
        "caveat": "cena sintetica; robustez a condicoes reais exige dado de campo (Fase 2)",
        "frames": frames_out,
    }
    if args.write:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(report, indent=2))
        print(f"   relatorio regravado: {args.json}")
    else:
        print(f"   (use --write para regravar {args.json})")
    return 0 if verdict else 1


if __name__ == "__main__":
    raise SystemExit(main())
