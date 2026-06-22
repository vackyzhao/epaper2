#!/usr/bin/env python3
"""Behavior-level checks for the 2.9in EPD update policy.

This model deliberately focuses on the controller-visible contract:
old/new frame RAM validity, full refresh, partial refresh, and deep sleep.
It does not try to model analog pigment physics, temperature, or waveform
quality.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class EpdModelError(RuntimeError):
    pass


@dataclass
class EpdBehaviorModel:
    awake: bool = False
    old_valid: bool = False
    new_valid: bool = False
    display_valid: bool = False
    display: str = "unknown"
    old_ram: str = "invalid"
    new_ram: str = "invalid"
    lut_mode: str = "unknown"
    mode2_ready: bool = False

    def init(self) -> None:
        self.awake = True
        self.old_valid = False
        self.new_valid = False
        self.old_ram = "invalid"
        self.new_ram = "invalid"
        self.mode2_ready = False

    def load_full_lut(self) -> None:
        self._require_awake("load_full_lut")
        self.lut_mode = "full"

    def load_partial_lut(self) -> None:
        self._require_awake("load_partial_lut")
        self.lut_mode = "partial"

    def mode2_setup(self) -> None:
        self._require_awake("mode2_setup")
        self.mode2_ready = self.lut_mode == "partial"

    def write_base(self, frame: str) -> None:
        self._require_awake("write_base")
        self.old_ram = frame
        self.new_ram = frame
        self.old_valid = True
        self.new_valid = True

    def write_old(self, frame: str) -> None:
        self._require_awake("write_old")
        self.old_ram = frame
        self.old_valid = True

    def write_new(self, frame: str) -> None:
        self._require_awake("write_new")
        self.new_ram = frame
        self.new_valid = True

    def full_refresh(self) -> None:
        self._require_awake("full_refresh")
        if not self.new_valid:
            raise EpdModelError("full refresh requires a valid new frame")
        self.display = self.new_ram
        self.display_valid = True

    def partial_refresh(self) -> None:
        self._require_awake("partial_refresh")
        if not self.display_valid:
            raise EpdModelError("partial refresh requires a known current display")
        if not self.old_valid or not self.new_valid:
            raise EpdModelError("partial refresh requires valid old and new frame RAM")
        if not self.mode2_ready:
            raise EpdModelError("partial refresh requires Mode 2 setup")
        if self.old_ram != self.display:
            raise EpdModelError("old frame RAM must match the currently visible frame")
        self.display = self.new_ram

    def sleep(self) -> None:
        self._require_awake("sleep")
        self.awake = False
        self.old_valid = False
        self.new_valid = False
        self.old_ram = "invalid"
        self.new_ram = "invalid"
        self.mode2_ready = False

    def _require_awake(self, op: str) -> None:
        if not self.awake:
            raise EpdModelError(f"{op} while EPD is asleep")


def countdown_wake_cycle() -> None:
    epd = EpdBehaviorModel()
    epd.init()
    epd.load_full_lut()
    epd.write_base("countdown 12:34")
    epd.full_refresh()
    epd.sleep()

    epd.init()
    epd.load_full_lut()
    epd.write_base("countdown 12:35")
    epd.full_refresh()
    epd.sleep()


def partial_after_sleep_must_fail() -> None:
    epd = EpdBehaviorModel()
    epd.init()
    epd.load_full_lut()
    epd.write_base("countdown 12:34")
    epd.full_refresh()
    epd.sleep()

    epd.init()
    epd.load_partial_lut()
    epd.mode2_setup()
    epd.write_new("countdown 12:35")
    try:
        epd.partial_refresh()
    except EpdModelError as exc:
        if "old and new frame RAM" in str(exc):
            return
        raise
    raise AssertionError("partial refresh after sleep unexpectedly passed")


def explicit_delta_same_wake_cycle() -> None:
    epd = EpdBehaviorModel()
    epd.init()
    epd.load_full_lut()
    epd.write_base("menu idle")
    epd.full_refresh()
    epd.load_partial_lut()
    epd.mode2_setup()
    epd.write_old("menu idle")
    epd.write_new("menu sending")
    epd.partial_refresh()
    epd.sleep()


def mode2_setup_does_not_touch_glass() -> None:
    epd = EpdBehaviorModel()
    epd.init()
    epd.load_full_lut()
    epd.write_base("calendar")
    epd.full_refresh()
    epd.load_partial_lut()
    epd.mode2_setup()
    assert epd.display == "calendar"


def source_policy_check(repo: Path) -> None:
    app_files = [
        repo / "src" / "main.cpp",
        repo / "lib" / "display_utils" / "src" / "display_utils.cpp",
    ]
    forbidden = ("DisplayFrame_Partial", "SetFrameMemory_Partial(")
    for file_path in app_files:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        for token in forbidden:
            if token in text:
                raise AssertionError(f"{file_path}: application layer still calls {token}")


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    countdown_wake_cycle()
    partial_after_sleep_must_fail()
    explicit_delta_same_wake_cycle()
    mode2_setup_does_not_touch_glass()
    source_policy_check(repo)
    print("EPD behavior model checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
