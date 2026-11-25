import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gemini_capabilities import inventory  # noqa: E402
from gemini_capabilities.dpapi import HelperError  # noqa: E402


MODELS = """## All Gemini 3 models  {% id="all-gemini-3-models" %}
  * `gemini-3.1-flash-lite`
  * `gemini-3.5-flash-lite`
  * `gemini-3.6-flash`
  * `gemini-3.8-flash`
  * `gemini-3.8-flash-tts`
  * `gemini-3.9-flash-preview`
## All Gemini 4 models  {% id="all-gemini-4-models" %}
  * `gemini-4-carbon`
  * `gemini-4-neon`
"""

STANDARD_TABLE = """  {% tab title="Standard" %}
  {% table %}
  * Feature
  * Free Tier
  * Paid Tier, per 1M tokens in USD

  ---

  * Input price
  * Free of charge
  * $0.75 through December 31, 2026.
  $1.50 starting January 1, 2027.

  ---

  * Output price (including thinking tokens)
  * Free of charge
  * $3.75 through December 31, 2026.
  $7.50 starting January 1, 2027.
  {% /table %}
  {% /tab %}
"""


def pricing(model, table=STANDARD_TABLE):
    return f'## Model  {{% id="{model}" %}}\n{table}\n'


def visible(*models):
    return [{"name": model, "methods": ["generateContent", "countTokens"],
             "input_token_limit": 1_048_576, "output_token_limit": 32_768} for model in models]


class InventoryTests(unittest.TestCase):
    def test_current_canonical_models_keep_distinct_lines_and_future_prices(self):
        registry_names = ("gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-carbon", "gemini-4-neon")
        prices = "".join(pricing(model) for model in registry_names)
        project = visible(*registry_names, "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash-tts", "gemini-3.9-flash-preview")
        catalog = inventory.build_catalog(MODELS, prices, project, "2026-11-25T00:00:00Z")
        self.assertEqual(set(catalog["models"]), set(registry_names))
        self.assertEqual(catalog["superseded"], {"gemini-3.1-flash-lite": "gemini-3.5-flash-lite", "gemini-3.6-flash": "gemini-3.8-flash"})
        self.assertEqual(catalog["models"]["gemini-4-carbon"]["prices"][-1],
                         {"from": "2027-01-01", "input": "1.50", "output": "7.50"})

    def test_unknown_latest_price_never_revives_an_older_model(self):
        unsupported = STANDARD_TABLE.replace("$0.75 through December 31, 2026.", "$0.75 for prompts <= 200k.")
        prices = pricing("gemini-3.6-flash") + pricing("gemini-3.8-flash", unsupported) + pricing("gemini-4-neon")
        catalog = inventory.build_catalog(MODELS, prices, visible("gemini-3.6-flash", "gemini-3.8-flash", "gemini-4-neon"), "now")
        self.assertEqual(set(catalog["models"]), {"gemini-4-neon"})
        self.assertIn("gemini-3.8-flash", catalog["unavailable"])
        self.assertEqual(catalog["superseded"]["gemini-3.6-flash"], "gemini-3.8-flash")
        with self.assertRaises(HelperError):
            inventory.build_catalog(MODELS, prices, visible("gemini-3.8-flash"), "now")

    def test_model_missing_required_method_never_becomes_routable(self):
        model = visible("gemini-4-neon")[0]
        model["methods"] = ["generateContent"]
        with self.assertRaises(HelperError):
            inventory.build_catalog(MODELS, pricing("gemini-4-neon"), [model], "now")
