#!/usr/bin/env python3
"""Serve the browser-based epaper2 device simulator."""

from __future__ import annotations

import argparse
import http.server
import json
import mimetypes
import shutil
import socketserver
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class SimulatorRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, root: Path, repo_root: Path, **kwargs):
        self.root = root
        self.repo_root = repo_root
        super().__init__(*args, directory=str(root), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/firmware.hex":
            self._serve_file(self.repo_root / ".pio" / "build" / "328p8m" / "firmware.hex", "text/plain")
            return
        if path == "/api/firmware/symbols":
            self._serve_json(firmware_symbols(self.repo_root))
            return
        if path == "/api/backends":
            self._serve_json(probe_backends())
            return
        if path == "/api/ltspice/power":
            self._serve_json(run_ltspice_power(parse_qs(parsed.query)))
            return
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self._serve_json({"ok": False, "error": f"Invalid JSON: {exc}"})
            return
        if path == "/api/simulink/power":
            self._serve_json(run_simulink_power(payload))
            return
        self.send_error(404, f"Unknown API: {path}")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _serve_file(self, path: Path, content_type: str | None = None) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(404, f"Missing file: {path.name}")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_json(self, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _first_existing(candidates: list[str]) -> str | None:
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def _avr_tool(tool: str) -> str | None:
    exe = f"{tool}.exe"
    return shutil.which(tool) or shutil.which(exe) or _first_existing(
        [
            str(Path.home() / ".platformio" / "packages" / "toolchain-atmelavr" / "bin" / exe),
            str(Path.home() / ".platformio" / "packages" / "toolchain-atmelavr" / "bin" / tool),
        ]
    )


def firmware_symbols(repo_root: Path) -> dict:
    elf = repo_root / ".pio" / "build" / "328p8m" / "firmware.elf"
    if not elf.exists():
        return {"ok": False, "error": "firmware.elf not found; run PlatformIO build first", "sram": [], "flash": []}

    avr_nm = _avr_tool("avr-nm")
    if not avr_nm:
        return {"ok": False, "error": "avr-nm not found", "elf": str(elf), "sram": [], "flash": []}

    try:
        completed = subprocess.run(
            [avr_nm, "-S", "--size-sort", "--demangle", str(elf)],
            cwd=repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "avr-nm timed out", "elf": str(elf), "nm": avr_nm, "sram": [], "flash": []}

    if completed.returncode != 0:
        return {
            "ok": False,
            "error": "avr-nm failed",
            "returncode": completed.returncode,
            "stderr": completed.stderr[-2000:],
            "elf": str(elf),
            "nm": avr_nm,
            "sram": [],
            "flash": [],
        }

    sram_start = 0x0100
    sram_bytes = 2048
    sram_vma_base = 0x800000
    flash_bytes = 32768
    sram = []
    flash = []

    for raw_line in completed.stdout.splitlines():
        parts = raw_line.split(maxsplit=3)
        if len(parts) < 4:
            continue
        addr_s, size_s, kind, name = parts
        try:
            addr = int(addr_s, 16)
            size = int(size_s, 16)
        except ValueError:
            continue
        if size <= 0:
            continue

        if kind in "bBdDnN" and sram_vma_base + sram_start <= addr < sram_vma_base + sram_start + sram_bytes:
            offset = addr - sram_vma_base - sram_start
            sram.append(
                {
                    "name": name,
                    "kind": kind,
                    "address": addr - sram_vma_base,
                    "addressHex": f"0x{addr - sram_vma_base:04x}",
                    "offset": offset,
                    "offsetHex": f"0x{offset:04x}",
                    "size": min(size, sram_bytes - offset),
                    "sizeHex": f"0x{size:04x}",
                }
            )
        elif kind in "tTrRwW" and 0 <= addr < flash_bytes:
            flash.append(
                {
                    "name": name,
                    "kind": kind,
                    "address": addr,
                    "addressHex": f"0x{addr:04x}",
                    "offset": addr,
                    "offsetHex": f"0x{addr:04x}",
                    "size": min(size, flash_bytes - addr),
                    "sizeHex": f"0x{size:04x}",
                }
            )

    sram.sort(key=lambda item: item["offset"])
    flash.sort(key=lambda item: item["offset"])
    return {
        "ok": True,
        "elf": str(elf),
        "nm": avr_nm,
        "sram": sram,
        "flash": flash,
        "summary": {
            "sramSymbolBytes": sum(item["size"] for item in sram),
            "sramSymbolCount": len(sram),
            "flashSymbolBytes": sum(item["size"] for item in flash),
            "flashSymbolCount": len(flash),
        },
    }


def probe_backends() -> dict:
    matlab = shutil.which("matlab") or _first_existing(
        [
            r"C:\Program Files\MATLAB\R2025a\bin\matlab.exe",
            r"C:\Program Files\MATLAB\R2024b\bin\matlab.exe",
            r"C:\Program Files\MATLAB\R2024a\bin\matlab.exe",
        ]
    )
    ltspice = shutil.which("XVIIx64") or shutil.which("ltspice") or _first_existing(
        [
            r"C:\Program Files\LTC\LTspiceXVII\XVIIx64.exe",
            r"C:\Program Files\ADI\LTspice\LTspice.exe",
        ]
    )
    return {
        "matlab": {"available": bool(matlab), "path": matlab},
        "ltspice": {"available": bool(ltspice), "path": ltspice},
    }


def _query_float(query: dict[str, list[str]], name: str, default: float, min_value: float | None = None) -> float:
    try:
        value = float(query.get(name, [default])[0])
    except (TypeError, ValueError):
        value = default
    if min_value is not None:
        value = max(min_value, value)
    return value


def run_ltspice_power(query: dict[str, list[str]]) -> dict:
    backends = probe_backends()
    ltspice = backends["ltspice"]["path"]
    if not ltspice:
        return {"ok": False, "error": "LTspice executable not found", "backends": backends}

    battery_v = _query_float(query, "batteryMv", 3600, 0) / 1000.0
    battery_count = round(_query_float(query, "batteryCount", 2, 1))
    r_internal = (_query_float(query, "internalResistanceMohm", 240, 0) / max(1, battery_count)) / 1000.0
    continuous_limit_a = (_query_float(query, "continuousLimitMa", 100, 0) * max(1, battery_count)) / 1000.0
    pulse_limit_a = (_query_float(query, "pulseLimitMa", 200, 0) * max(1, battery_count)) / 1000.0
    unit_cap_f = _query_float(query, "unitCapacitanceF", 0.5, 0.01)
    cap_count = round(_query_float(query, "supercapCount", 2, 1))
    unit_charge_r = _query_float(query, "unitChargeOhms", 10, 0.1)
    resistor_count = round(_query_float(query, "chargeResistorCount", 2, 1))
    cap_esr = _query_float(query, "supercapEsrMohm", 800, 0) / 1000.0
    air_pulse_a = _query_float(query, "airPulseMa", 430, 0) / 1000.0
    air_sustain_a = _query_float(query, "airSustainMa", 5, 0) / 1000.0
    pulse_ms = _query_float(query, "txPulseMs", 0.5, 0.001)
    switch_r = _query_float(query, "switchResistanceMohm", 80, 0) / 1000.0
    diode_mv = _query_float(query, "diodeDropMv", 250, 0)

    cap_f = unit_cap_f * cap_count
    charge_r = unit_charge_r / resistor_count
    netlist = f"""* epaper2 LTE reservoir cross-check
V1 nbat 0 DC {battery_v:.6g}
Rint nbat vbat {r_internal:.6g}
Rpmos vbat vlte {switch_r:.6g}
Ibias vlte 0 DC {min(air_sustain_a, continuous_limit_a):.6g}
Rchg vbat cap {charge_r:.6g}
Ccap cap 0 {cap_f:.6g} IC={battery_v:.6g}
Rcap cap capd {cap_esr:.6g}
Dcap capd vlte Dsch
Iair vlte 0 PULSE(0 {max(0.0, air_pulse_a - min(air_sustain_a, continuous_limit_a)):.6g} 100m 5u 5u {pulse_ms:.6g}m 1200m)
.model Dsch D(Is=1e-6 N=1.05 Rs=0.050 Cjo=50p Eg=0.69)
.tran 0 5 0 500u startup
.save V(vbat) V(vlte) V(cap)
.options plotwinsize=0
.end
"""

    with tempfile.TemporaryDirectory(prefix="epaper2-ltspice-") as tmp:
        tmp_path = Path(tmp)
        circuit = tmp_path / "epaper2_power.cir"
        circuit.write_text(netlist, encoding="utf-8")
        started = time.time()
        try:
            completed = subprocess.run(
                [ltspice, "-b", str(circuit)],
                cwd=tmp,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=25,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "LTspice batch timed out", "netlist": netlist, "backends": backends}

        log_path = circuit.with_suffix(".log")
        log_tail = ""
        if log_path.exists():
            log_tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-20:])
        raw_path = circuit.with_suffix(".raw")
        return {
            "ok": completed.returncode == 0 and raw_path.exists(),
            "returncode": completed.returncode,
            "elapsedMs": round((time.time() - started) * 1000),
            "effective": {
                "capacitanceF": cap_f,
                "batteryCount": battery_count,
                "batteryInternalOhms": r_internal,
                "chargeOhms": charge_r,
                "supercapEsrOhms": cap_esr,
                "switchOhms": switch_r,
                "continuousLimitA": continuous_limit_a,
                "pulseLimitA": pulse_limit_a,
                "diodeDropMv": diode_mv,
            },
            "stdout": completed.stdout[-2000:],
            "stderr": completed.stderr[-2000:],
            "logTail": log_tail,
            "rawProduced": raw_path.exists(),
            "netlist": netlist,
            "backends": backends,
        }


def _matlab_quote(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


def run_simulink_power(payload: dict) -> dict:
    backends = probe_backends()
    matlab = backends["matlab"]["path"]
    if not matlab:
        return {"ok": False, "error": "MATLAB executable not found", "backends": backends}

    script_path = Path(__file__).resolve().parent / "matlab" / "epaper2_simulink_power.m"
    if not script_path.exists():
        return {"ok": False, "error": f"Missing MATLAB script: {script_path}", "backends": backends}

    with tempfile.TemporaryDirectory(prefix="epaper2-simulink-") as tmp:
        tmp_path = Path(tmp)
        input_path = tmp_path / "input.json"
        output_path = tmp_path / "output.json"
        input_path.write_text(json.dumps(payload), encoding="utf-8")
        started = time.time()
        env = dict(**{k: v for k, v in subprocess.os.environ.items()})
        env["EPAPER2_POWER_INPUT"] = str(input_path)
        env["EPAPER2_POWER_OUTPUT"] = str(output_path)
        try:
            completed = subprocess.run(
                [matlab, "-batch", f"addpath('{_matlab_quote(script_path.parent)}'); epaper2_simulink_power"],
                cwd=tmp,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=150,
                check=False,
                env=env,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Simulink/MATLAB batch timed out", "backends": backends}
        if not output_path.exists():
            return {
                "ok": False,
                "error": "Simulink/MATLAB did not produce output",
                "returncode": completed.returncode,
                "stdout": completed.stdout[-3000:],
                "stderr": completed.stderr[-3000:],
                "backends": backends,
            }
        result = json.loads(output_path.read_text(encoding="utf-8"))
        result.update(
            {
                "ok": bool(result.get("ok")),
                "returncode": completed.returncode,
                "elapsedMs": round((time.time() - started) * 1000),
                "backends": backends,
            }
        )
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the epaper2 browser simulator.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    repo_root = root.parents[1]
    handler = lambda *handler_args, **handler_kwargs: SimulatorRequestHandler(  # noqa: E731
        *handler_args,
        root=root,
        repo_root=repo_root,
        **handler_kwargs,
    )
    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        print(f"epaper2 simulator: http://{args.host}:{args.port}/")
        httpd.serve_forever()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
