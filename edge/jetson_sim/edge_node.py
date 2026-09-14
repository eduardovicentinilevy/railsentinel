#!/usr/bin/env python3
"""
Simulador de no Edge AI - NVIDIA Jetson Orin em toten de cruzamento.

Espelha o que roda no dispositivo real. Em campo, o laco de inferencia e um
pipeline DeepStream/TensorRT sobre o JetPack; aqui ele e substituido por um
gerador de eventos, mas TUDO a jusante da inferencia - envelope, assinatura,
topico, QoS, heartbeat, LWT - e identico ao codigo de producao. Essa fronteira
foi escolhida de proposito: e o contrato de mensageria que precisa ser validado
na Fase 1, nao o detector.

Por que Python aqui e TypeScript no CCO: no Orin, o ecossistema de inferencia
(DeepStream, TensorRT, pyds) e Python/C++, entao a borda acompanha o hardware.
O middleware do CCO e ligado a E/S e a concorrencia, onde Node se sai melhor.
Cada lado usa a linguagem da sua restricao dominante.

Uso:
    python3 edge_node.py --scenario intrusion
    python3 edge_node.py --scenario degraded
    python3 edge_node.py --scenario spoof     # tentativa de falsificacao
"""
from __future__ import annotations

import argparse
import json
import os
import random
import secrets
import signal
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import paho.mqtt.client as mqtt
except ImportError:
    sys.exit("Falta dependencia: pip install paho-mqtt cryptography")

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
except ImportError:
    sys.exit("Falta dependencia: pip install cryptography")

REPO = Path(__file__).resolve().parents[2]


# --------------------------------------------------------------------------
# Serializacao canonica - precisa casar byte a byte com packages/contracts
# --------------------------------------------------------------------------

def canonicalize(value: Any) -> str:
    """JCS (RFC 8785) simplificado.

    Se esta funcao divergir da implementacao TypeScript em uma unica virgula, a
    verificacao de assinatura falha no gateway. Os testes de interoperabilidade
    em tests/ existem exatamente para travar esse acoplamento.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted((k, v) for k, v in value.items() if v is not None)
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonicalize(v)}" for k, v in items) + "}"
    raise TypeError(f"nao serializavel: {type(value)}")


def uuidv7() -> str:
    ms = int(time.time() * 1000)
    rand = secrets.token_bytes(10)
    b = bytearray(ms.to_bytes(6, "big") + rand)
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(b)))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------

@dataclass
class NodeConfig:
    src: str
    kid: str
    site: str
    line: str
    zone: str
    section_id: str
    lat: float
    lon: float
    private_key_pem: str


class EdgeNode:
    """No de borda: publica heartbeat, telemetria e eventos assinados."""

    MODEL = "railguard-yolo"
    MODEL_VERSION = "3.2.1"

    def __init__(self, cfg: NodeConfig, broker: str, port: int) -> None:
        self.cfg = cfg
        self.seq = 0
        self.started = time.time()
        # Sessao de boot (epoch ms). Ver ReplayGuard: e o que separa um reinicio
        # legitimo do no de uma reinjecao de trafego antigo.
        self.boot = int(self.started * 1000)
        self.key = serialization.load_pem_private_key(cfg.private_key_pem.encode(), password=None)
        assert isinstance(self.key, Ed25519PrivateKey)

        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cfg.src.replace(":", "-"))

        # Last Will and Testament: se o no cair, o broker publica este offline
        # por conta propria. Sem LWT, uma camera morta silencia e o CCO poderia
        # interpretar o silencio como "nenhuma invasao" - o modo de falha mais
        # perigoso possivel num sistema de deteccao.
        self.client.will_set(
            self.topic("hb"),
            json.dumps(self.envelope_message(
                "vlt.edge.health.v1", "critical",
                {"status": "offline", "reason": "conexao perdida (LWT do broker)"},
            )),
            qos=1, retain=True,
        )
        self.client.on_connect = lambda c, u, f, rc, p=None: print(f"[{cfg.src}] conectado ao broker de campo (rc={rc})")
        self.client.connect(broker, port, keepalive=15)
        self.client.loop_start()

    # -- construcao de mensagem -------------------------------------------

    def topic(self, stream: str, name: str | None = None) -> str:
        base = f"vlt/{self.cfg.site}/{self.cfg.line}/{self.cfg.zone}/edge/{self.cfg.src.split(':')[2]}/{stream}"
        return f"{base}/{name}" if name else base

    def envelope_message(self, msg_type: str, sev: str, data: dict, *, sign: bool = True) -> dict:
        self.seq += 1
        env = {
            "v": 1,
            "id": uuidv7(),
            "seq": self.seq,
            "boot": self.boot,
            "ts": now_iso(),
            "src": self.cfg.src,
            "site": self.cfg.site,
            "line": self.cfg.line,
            "zone": self.cfg.zone,
            "type": msg_type,
            # EN 50716: todo evento originado de IA sai marcado como Integridade
            # Basica. A marca viaja com o dado - nao e inferida no destino.
            "class": "basic",
            "sev": sev,
        }
        msg: dict[str, Any] = {"env": env, "data": data}
        if sign:
            payload = canonicalize({"env": env, "data": data}).encode("utf-8")
            sig = self.key.sign(payload)
            import base64
            msg["sig"] = {
                "alg": "Ed25519",
                "kid": self.cfg.kid,
                "val": base64.urlsafe_b64encode(sig).decode().rstrip("="),
            }
        return msg

    def publish(self, stream: str, msg: dict, name: str | None = None, *, retain: bool = False) -> None:
        topic = self.topic(stream, name)
        self.client.publish(topic, json.dumps(msg, ensure_ascii=False), qos=1, retain=retain)
        print(f"[{self.cfg.src}] -> {topic}  ({msg['env']['type']}, seq={msg['env']['seq']})")

    # -- comportamentos ---------------------------------------------------

    def heartbeat(self, status: str = "ok", reason: str | None = None) -> None:
        data = {
            "status": status,
            "uptime_s": int(time.time() - self.started),
            "cpu_pct": round(random.uniform(28, 46), 1),
            "gpu_temp_c": round(random.uniform(52, 67), 1),
            "fps": round(random.uniform(28, 31), 1) if status == "ok" else round(random.uniform(4, 11), 1),
            "last_infer_age_ms": random.randint(28, 40) if status == "ok" else random.randint(900, 3000),
            "camera_link": "up" if status == "ok" else "flapping",
            "model_loaded": True,
        }
        if reason:
            data["reason"] = reason
        sev = "info" if status == "ok" else "major"
        self.publish("hb", self.envelope_message("vlt.edge.health.v1", sev, data), retain=True)

    def intrusion(self, obj_class: str, conf: float, state: str = "onset",
                  gauge_margin: float = -0.35, dwell_ms: int = 1200) -> dict:
        data = {
            "event": "gauge_intrusion",
            "state": state,
            "object": {
                "class": obj_class,
                "conf": round(conf, 3),
                "track_id": f"t-{random.randint(100, 999)}",
                "bbox_norm": [round(random.uniform(.2, .4), 3), round(random.uniform(.4, .6), 3),
                              round(random.uniform(.5, .7), 3), round(random.uniform(.7, .9), 3)],
            },
            "geo": {"lat": self.cfg.lat, "lon": self.cfg.lon, "accuracy_m": 2.5},
            "track": {
                "section_id": self.cfg.section_id,
                "chainage_m": round(random.uniform(200, 900), 1),
                "gauge_margin_m": gauge_margin,
                "direction": "both",
            },
            "detector": {
                "model": self.MODEL,
                "model_version": self.MODEL_VERSION,
                "infer_ms": round(random.uniform(9.5, 14.0), 2),
                "frame_ts": now_iso(),
                "pipeline": "deepstream-7.0",
            },
            # Modelo PULL: so o ponteiro trafega. O clipe fica no Orin, ja com
            # faces borradas (LGPD), e o CCO busca se o operador pedir.
            "evidence": {
                "ref": f"edge://{self.cfg.src.split(':')[2]}/clips/{uuidv7()}",
                "ttl_s": 900, "retrieval": "pull", "redacted": True,
            },
            "dwell_ms": dwell_ms,
        }
        sev = "critical" if (obj_class == "person" or gauge_margin < 0) else "major"
        msg = self.envelope_message("vlt.edge.intrusion.v1", sev, data)
        self.publish("evt", msg, "intrusion")
        return msg

    def stop(self) -> None:
        self.heartbeat("offline", "desligamento controlado")
        time.sleep(0.3)
        self.client.loop_stop()
        self.client.disconnect()


# --------------------------------------------------------------------------
# Cenarios
# --------------------------------------------------------------------------

def load_node(registry_path: Path, src: str) -> NodeConfig:
    reg = json.loads(registry_path.read_text())
    for d in reg["devices"]:
        if d["src"] == src:
            return NodeConfig(
                src=d["src"], kid=d["kid"], site="santos", line=d["line"], zone=d["zone"],
                section_id=d["section_id"], lat=d["lat"], lon=d["lon"],
                private_key_pem=d["privateKeyPem"],
            )
    sys.exit(f"dispositivo {src} nao encontrado em {registry_path}. Rode: npm run keys")


def scenario_intrusion(node: EdgeNode) -> None:
    print("\n=== CENARIO: invasao de gabarito por automovel ===\n")
    node.heartbeat("ok")
    time.sleep(1.5)

    print("-- deteccao de baixa confianca (deve ser FILTRADA pelo ATS) --")
    node.intrusion("car", conf=0.41, gauge_margin=0.4, dwell_ms=1500)
    time.sleep(2)

    print("\n-- deteccao transitoria de 1 quadro (deve ser FILTRADA por persistencia) --")
    node.intrusion("debris", conf=0.88, gauge_margin=0.2, dwell_ms=90)
    time.sleep(2)

    print("\n-- INVASAO REAL: automovel dentro do gabarito dinamico --")
    node.intrusion("car", conf=0.94, gauge_margin=-0.35, dwell_ms=2400)
    time.sleep(3)

    print("\n-- condicao persistindo --")
    node.intrusion("car", conf=0.96, state="sustained", gauge_margin=-0.35, dwell_ms=5200)
    time.sleep(3)

    print("\n-- borda reporta normalizacao (NAO libera a via sozinha) --")
    node.intrusion("car", conf=0.91, state="cleared", gauge_margin=0.8, dwell_ms=0)
    time.sleep(2)
    node.heartbeat("ok")


def scenario_degraded(node: EdgeNode) -> None:
    print("\n=== CENARIO: degradacao do no (fail-visible) ===\n")
    node.heartbeat("ok")
    time.sleep(2)
    print("-- enlace de camera instavel --")
    node.heartbeat("degraded", "enlace de camera intermitente; fps abaixo do minimo")
    time.sleep(2)
    print("-- falha do no: a secao perde cobertura de deteccao --")
    node.heartbeat("fault", "pipeline de inferencia parou de responder")
    time.sleep(2)


def scenario_spoof(node: EdgeNode) -> None:
    """Prova negativa: o que a fronteira recusa."""
    print("\n=== CENARIO: tentativas de falsificacao (todas devem ser RECUSADAS) ===\n")
    node.heartbeat("ok")
    time.sleep(1)

    print("-- 1. mensagem sem assinatura --")
    msg = node.envelope_message("vlt.edge.intrusion.v1", "critical", {
        "event": "gauge_intrusion", "state": "cleared",
        "object": {"class": "car", "conf": 0.99},
        "track": {"section_id": node.cfg.section_id},
        "detector": {"model": "x", "model_version": "0", "infer_ms": 1},
    }, sign=False)
    node.publish("evt", msg, "intrusion")
    time.sleep(1.5)

    print("-- 2. payload alterado apos a assinatura --")
    msg = node.envelope_message("vlt.edge.intrusion.v1", "critical", {
        "event": "gauge_intrusion", "state": "onset",
        "object": {"class": "person", "conf": 0.5},
        "track": {"section_id": node.cfg.section_id},
        "detector": {"model": node.MODEL, "model_version": node.MODEL_VERSION, "infer_ms": 10},
    })
    msg["data"]["object"]["conf"] = 0.99  # adulteracao
    node.publish("evt", msg, "intrusion")
    time.sleep(1.5)

    print("-- 3. publicacao no topico de OUTRO cruzamento (falsificacao de identidade) --")
    msg = node.envelope_message("vlt.edge.intrusion.v1", "critical", {
        "event": "gauge_intrusion", "state": "onset",
        "object": {"class": "truck", "conf": 0.95},
        "track": {"section_id": "L2-S14"},
        "detector": {"model": node.MODEL, "model_version": node.MODEL_VERSION, "infer_ms": 10},
    })
    foreign = f"vlt/santos/L2/XC-JOAO-PESSOA/edge/XC-JOAO-PESSOA-01/evt/intrusion"
    node.client.publish(foreign, json.dumps(msg), qos=1)
    print(f"[{node.cfg.src}] -> {foreign}  (falsificando outro no)")
    time.sleep(1.5)

    print("-- 4. replay de um evento legitimo anterior --")
    legit = node.envelope_message("vlt.edge.intrusion.v1", "major", {
        "event": "gauge_intrusion", "state": "onset",
        "object": {"class": "car", "conf": 0.92},
        "track": {"section_id": node.cfg.section_id, "gauge_margin_m": -0.2},
        "detector": {"model": node.MODEL, "model_version": node.MODEL_VERSION, "infer_ms": 11},
        "dwell_ms": 1800,
    })
    node.publish("evt", legit, "intrusion")
    time.sleep(1)
    node.publish("evt", legit, "intrusion")  # bit a bit identico
    time.sleep(1.5)


SCENARIOS = {"intrusion": scenario_intrusion, "degraded": scenario_degraded, "spoof": scenario_spoof}


def main() -> None:
    ap = argparse.ArgumentParser(description="Simulador de no Edge AI (NVIDIA Jetson Orin)")
    ap.add_argument("--scenario", choices=list(SCENARIOS) + ["loop"], default="intrusion")
    ap.add_argument("--src", default="edge:jetson:XC-ANA-COSTA-01")
    ap.add_argument("--broker", default=os.environ.get("FIELD_BROKER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("FIELD_BROKER_PORT", "1883")))
    ap.add_argument("--registry", default=str(REPO / ".secrets" / "edge-keys.json"))
    args = ap.parse_args()

    cfg = load_node(Path(args.registry), args.src)
    node = EdgeNode(cfg, args.broker, args.port)
    time.sleep(0.6)

    stopping = False

    def shutdown(*_: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        if args.scenario == "loop":
            print("\n=== MODO CONTINUO: heartbeat + invasao esporadica (Ctrl+C encerra) ===\n")
            tick = 0
            while not stopping:
                node.heartbeat("ok")
                tick += 1
                if tick % 6 == 0:
                    node.intrusion(random.choice(["car", "person", "bicycle"]),
                                   conf=random.uniform(0.75, 0.98), gauge_margin=-0.3,
                                   dwell_ms=random.randint(900, 4000))
                time.sleep(5)
        else:
            SCENARIOS[args.scenario](node)
    finally:
        node.stop()
        print(f"\n[{cfg.src}] encerrado.")


if __name__ == "__main__":
    main()
