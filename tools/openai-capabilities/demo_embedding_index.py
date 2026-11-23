"""Build and query the tiny synthetic index from already-collected test vectors.

This local demonstration makes no API calls. Its input is the completed
embedding-index.json example artifact.
"""
import argparse
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--embedding-artifact", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = json.loads(args.embedding_artifact.read_text(encoding="utf-8"))
    example = json.loads((Path(__file__).parent / "examples" / "embedding-index.json").read_text(encoding="utf-8"))
    texts = example["payload"]["input"]
    query_text = texts[2]
    if result["status"] != "completed" or len(result["output"]) != 3:
        raise ValueError("Use the completed three-vector example artifact")
    query = result["output"][2]

    def vector(values):
        if len(values) != 256 or any(type(x) not in (int, float) or not math.isfinite(x) for x in values):
            raise ValueError("Expected 256 finite numeric values")
        length = math.sqrt(sum(x * x for x in values))
        if not length:
            raise ValueError("Zero vector")
        return [x / length for x in values]

    query = vector(query)
    index = [{"id": ident, "text": text, "vector": vector(values)}
             for ident, text, values in zip(("recovery", "funding"), texts[:2], result["output"][:2])]
    matches = sorted(({"id": item["id"], "text": item["text"],
                       "cosine_similarity": sum(a * b for a, b in zip(query, item["vector"]))}
                      for item in index), key=lambda item: item["cosine_similarity"], reverse=True)
    result = {"status": "completed", "api_calls": 0, "query": query_text,
              "index": index, "matches": matches,
              "source_artifact": str(args.embedding_artifact.resolve())}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "completed", "api_calls": 0, "matches": matches,
                      "artifact": str(args.output.resolve())}))


if __name__ == "__main__":
    main()
