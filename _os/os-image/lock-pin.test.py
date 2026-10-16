"""Exercise the root helper without changing any account or starting a password tool."""
import io
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import patch


HELPER = Path(__file__).parent / "rootfs/usr/libexec/intentic-os/lock-pin"


class LockPinTest(unittest.TestCase):
    def invoke(self, data, args=()):
        with patch.object(sys, "stdin", types.SimpleNamespace(buffer=io.BytesIO(data))), \
                patch.object(sys, "argv", [str(HELPER), *args]), \
                patch("subprocess.run") as run:
            run.return_value.returncode = 0
            with self.assertRaises(SystemExit) as result:
                runpy.run_path(str(HELPER), run_name="__main__")
            return result.exception.code, run.call_args_list

    def test_valid_pins_only_change_intentic_on_stdin(self):
        for pin in [b"1234", b"0000\n", b"123456789012"]:
            with self.subTest(pin_length=len(pin)):
                code, calls = self.invoke(pin)
                self.assertEqual(code, 0)
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0].args, (["/usr/sbin/chpasswd"],))
                self.assertEqual(calls[0].kwargs, {"input": b"intentic:" + pin.rstrip(b"\n") + b"\n", "check": False})

    def test_rejects_other_users_flags_non_digits_and_extra_input(self):
        for data, args in [(b"123", ()), (b"1234567890123", ()), (b"1234\0", ()),
                           (b"1234\n\n", ()), (b"1234\nroot:5678", ()),
                           (b"root:1234", ()), (b"1234", ("root",)),
                           (b"1234", ("--off",)), (b"1234", ("--off", "root"))]:
            with self.subTest(length=len(data), args=args):
                code, calls = self.invoke(data, args)
                self.assertEqual(code, 1)
                self.assertEqual(calls, [])

    def test_off_only_locks_intentic_and_accepts_no_pin(self):
        code, calls = self.invoke(b"", ("--off",))
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args, (["/usr/sbin/usermod", "--lock", "intentic"],))
        self.assertEqual(calls[0].kwargs, {"check": False})


if __name__ == "__main__":
    unittest.main()
