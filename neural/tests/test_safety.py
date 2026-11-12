import os
import unittest

from bdh_memory.safety import configure_model_download, ensure_torch_load_allowed, torch_version_tuple


class TorchGuardTest(unittest.TestCase):
    def test_version_tuple_ignores_local_suffixes(self) -> None:
        self.assertEqual(torch_version_tuple("2.10.0+cpu"), (2, 10, 0))
        self.assertLess(torch_version_tuple("2.9.1"), (2, 10, 0))

    def test_old_torch_cannot_load_state_unless_opted_out(self) -> None:
        with self.assertRaises(RuntimeError):
            ensure_torch_load_allowed("2.9.1")
        previous = os.environ.get("BDH_ALLOW_UNSAFE_TORCH")
        os.environ["BDH_ALLOW_UNSAFE_TORCH"] = "1"
        try:
            ensure_torch_load_allowed("2.5.1")
        finally:
            if previous is None:
                os.environ.pop("BDH_ALLOW_UNSAFE_TORCH", None)
            else:
                os.environ["BDH_ALLOW_UNSAFE_TORCH"] = previous

    def test_model_download_stays_offline(self) -> None:
        previous_offline = os.environ.get("HF_HUB_OFFLINE")
        previous_allow = os.environ.get("BDH_ALLOW_MODEL_DOWNLOAD")
        os.environ.pop("BDH_ALLOW_MODEL_DOWNLOAD", None)
        try:
            configure_model_download()
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
        finally:
            if previous_offline is None:
                os.environ.pop("HF_HUB_OFFLINE", None)
            else:
                os.environ["HF_HUB_OFFLINE"] = previous_offline
            os.environ.pop("TRANSFORMERS_OFFLINE", None)
            if previous_allow is None:
                os.environ.pop("BDH_ALLOW_MODEL_DOWNLOAD", None)
            else:
                os.environ["BDH_ALLOW_MODEL_DOWNLOAD"] = previous_allow


if __name__ == "__main__":
    unittest.main()
