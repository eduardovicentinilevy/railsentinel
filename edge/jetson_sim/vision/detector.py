"""
Backends de deteccao.

O pipeline trata o detector como componente substituivel. Em campo, o backend e
TensorRT sobre o Jetson Orin, com um YOLO treinado no dominio (via urbana de
Santos, chuva, contraluz do fim de tarde na orla). Na bancada, sem GPU e sem
modelo treinado, o backend de movimento roda sobre os mesmos pixels e fornece
deteccoes reais para exercitar geometria, rastreio e orcamento de latencia.

A separacao e proposital: o que a Fase 1 precisa validar e o CONTRATO e a
GEOMETRIA. Os pesos do detector so podem ser avaliados com dado de campo
rotulado, que e trabalho da Fase 2.
"""
from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Detection:
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2
    cls: str
    confidence: float


class Detector(ABC):
    name: str = "abstract"
    version: str = "0"

    @abstractmethod
    def detect(self, frame: np.ndarray) -> list[Detection]:
        ...

    def warmup(self, frame: np.ndarray) -> None:
        self.detect(frame)


class MotionDetector(Detector):
    """Deteccao por subtracao de fundo + analise de contorno.

    Real e mensuravel: opera sobre os pixels, tem latencia propria e erra de
    formas caracteristicas (sombra, oclusao, objeto parado que e absorvido pelo
    fundo). Essas falhas importam - sao as mesmas que o pipeline a jusante
    precisa tolerar quando o backend for uma rede neural.

    A classificacao por proporcao da caixa e grosseira de proposito: distinguir
    pedestre de veiculo por geometria e o que se consegue sem modelo treinado, e
    deixa explicito onde a rede entra.
    """

    name = "motion-mog2"
    version = "1.0.0"

    def __init__(self, min_area_px: int = 900, history: int = 240) -> None:
        self._bg = cv2.createBackgroundSubtractorMOG2(history=history, varThreshold=28, detectShadows=True)
        self._min_area = min_area_px
        self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    def detect(self, frame: np.ndarray) -> list[Detection]:
        mask = self._bg.apply(frame)
        # 127 = sombra no MOG2. Descartar sombra evita que a mancha projetada de
        # um veiculo na calcada seja contada como objeto sobre a via - falso
        # positivo classico em camera de toten ao entardecer.
        _, mask = cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self._kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self._kernel, iterations=2)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out: list[Detection] = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < self._min_area:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            aspect = h / max(1, w)
            if aspect > 1.5:
                cls, conf = "person", min(0.92, 0.55 + area / 26000)
            elif w > 130:
                cls, conf = "truck", min(0.95, 0.60 + area / 42000)
            else:
                cls, conf = "car", min(0.96, 0.62 + area / 30000)
            out.append(Detection((x, y, x + w, y + h), cls, round(float(conf), 3)))
        return out


class OnnxDetector(Detector):
    """Backend ONNX Runtime para modelo YOLO.

    Ativado por RAILSENTINEL_ONNX_MODEL. O provider TensorRT so existe no Orin;
    fora dele o ONNX Runtime cai para CPU, e a latencia medida NAO representa o
    alvo embarcado - por isso o relatorio sempre registra qual provider rodou.
    """

    name = "onnx-yolo"

    def __init__(self, model_path: str, input_size: int = 640, classes: list[str] | None = None) -> None:
        import onnxruntime as ort

        providers = [p for p in ("TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider")
                     if p in ort.get_available_providers()]
        self._sess = ort.InferenceSession(model_path, providers=providers)
        self.provider = self._sess.get_providers()[0]
        self._input = self._sess.get_inputs()[0].name
        self._size = input_size
        self.version = os.path.basename(model_path)
        self._classes = classes or ["person", "bicycle", "car", "motorcycle", "bus", "truck"]

    def detect(self, frame: np.ndarray) -> list[Detection]:
        h, w = frame.shape[:2]
        img = cv2.resize(frame, (self._size, self._size))
        blob = (cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        raw = self._sess.run(None, {self._input: blob})[0]

        out: list[Detection] = []
        pred = np.squeeze(raw)
        if pred.ndim != 2:
            return out
        if pred.shape[0] < pred.shape[1]:
            pred = pred.T
        sx, sy = w / self._size, h / self._size
        for row in pred:
            scores = row[4:]
            k = int(np.argmax(scores))
            conf = float(scores[k])
            if conf < 0.35:
                continue
            cx, cy, bw, bh = row[:4]
            x1 = int((cx - bw / 2) * sx); y1 = int((cy - bh / 2) * sy)
            x2 = int((cx + bw / 2) * sx); y2 = int((cy + bh / 2) * sy)
            cls = self._classes[k] if k < len(self._classes) else "unknown"
            out.append(Detection((x1, y1, x2, y2), cls, round(conf, 3)))
        return out


def build_detector() -> Detector:
    """Escolhe o backend. ONNX quando ha modelo; movimento caso contrario."""
    model = os.environ.get("RAILSENTINEL_ONNX_MODEL")
    if model and os.path.exists(model):
        return OnnxDetector(model)
    return MotionDetector()


def timed_detect(det: Detector, frame: np.ndarray) -> tuple[list[Detection], float]:
    """Deteccao com latencia medida em milissegundos."""
    t0 = time.perf_counter()
    dets = det.detect(frame)
    return dets, (time.perf_counter() - t0) * 1000.0
