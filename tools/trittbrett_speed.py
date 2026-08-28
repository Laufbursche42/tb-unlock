#!/usr/bin/env python3
"""Build the Trittbrett BLE frames the web app sends, for cross-checking on the desk.

Dependency-free. Prints the exact bytes for the ZYD speed-limit write (register 0x20)
and the belegte legacy FF 55 control frames, so a tester can compare them against an
HCI snoop from a real device.

Usage:
    python tools/trittbrett_speed.py 25        # ZYD speed frame for 25 km/h
    python tools/trittbrett_speed.py           # a table of reference frames
"""
import sys


def crc16_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc & 0xFFFF


def hexs(bs):
    return " ".join("%02X" % b for b in bs)


def zyd_rw_param(addr, value):
    words = len(value) // 2
    head = [0x01, 0x17, (addr >> 8) & 0xFF, addr & 0xFF, (words >> 8) & 0xFF, words & 0xFF,
            (addr >> 8) & 0xFF, addr & 0xFF, (words >> 8) & 0xFF, words & 0xFF, len(value) & 0xFF] + list(value)
    crc = crc16_modbus(head)
    return head + [crc & 0xFF, (crc >> 8) & 0xFF]


def zyd_speed(kmh):
    v = int(round(kmh * 10)) & 0xFFFF   # opv = 10
    return zyd_rw_param(0x20, [(v >> 8) & 0xFF, v & 0xFF])


def zyd_tran(cmd):
    return [0xA5, cmd & 0xFF, (~cmd) & 0xFF, 0, 0, 0, 0, 0x5A]


def ff55(op, payload=None):
    payload = payload or []
    head = [0xFF, 0x55, op & 0xFF, len(payload) & 0xFF] + list(payload)
    return head + [sum(head) & 0xFF]


def main():
    if len(sys.argv) > 1:
        kmh = float(sys.argv[1])
        f = zyd_speed(kmh)
        print("ZYD speed %.0f km/h -> register 0x20 (value km/h*10 = %d):" % (kmh, int(round(kmh * 10))))
        print("  " + hexs(f))
        return 0
    print("Trittbrett reference frames")
    print("  ZYD speed 20 km/h : " + hexs(zyd_speed(20)))
    print("  ZYD speed 25 km/h : " + hexs(zyd_speed(25)))
    print("  ZYD sendTran      : " + hexs(zyd_tran(0)))
    print("  ZYD keep          : " + hexs([0xA5, 0x02, 0xFD, 0x5A]))
    print("  Legacy confirm    : " + hexs(ff55(0x01)))
    print("  Legacy gear D1    : " + hexs(ff55(0x1F, [0x02])))
    print("  Legacy gear D2    : " + hexs(ff55(0x1F, [0x03])))
    print("  Legacy unlock     : " + hexs(ff55(0x17, [0x01])))
    print("  Legacy lock       : " + hexs(ff55(0x17, [0x02])))
    print("  CRC-16/MODBUS(\"123456789\") = 0x%04X (expect 0x4B37)" % crc16_modbus(b"123456789"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
