from typing import Protocol

MODEL = "BAAI/bge-reranker-base"
MODEL_REVISION = "2cfc18c9415c912f9d8155881c133215df768a70"


class Scorer(Protocol):
    def score(self, query: str, texts: list[str], *, raw: bool) -> list[float]: ...


class CrossEncoderScorer:
    """A cross-encoder reads the query and each text together and scores the pair."""

    def __init__(self, model: str = MODEL, revision: str = MODEL_REVISION) -> None:
        from sentence_transformers import CrossEncoder
        from torch import nn

        self._model = CrossEncoder(model, revision=revision)
        self._identity = nn.Identity()

    def score(self, query: str, texts: list[str], *, raw: bool) -> list[float]:
        # The model's default activation is a sigmoid, which gives TEI's 0..1 scores.
        # raw_scores asks for the logits instead.
        scores = self._model.predict(  # pyright: ignore[reportUnknownMemberType]
            [(query, text) for text in texts],
            activation_fn=self._identity if raw else None,
            show_progress_bar=False,
        )
        return [float(s) for s in scores.tolist()]
