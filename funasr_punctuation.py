"""App-owned literal-text boundary for the pinned FunASR CTTransformer.

AutoModel and CTTransformer's generic loader both dispatch strings as URLs/files,
even with data_type='text'. Reuse the original inference bytecode with a private
globals dictionary replacing that loader; never patch FunASR/model globals.
Literal URL/path words also retain their case when the model capitalizes them.
Model weights, tokenizer, splitting and punctuation inference remain unchanged.
"""
from types import FunctionType


class _LiteralWord(str):
    def capitalize(self):
        return self


def _literal_words(split, text, **kwargs):
    words = split(text, **kwargs)
    return [
        _LiteralWord(word) if word.startswith(("http://", "https://", "/", "./", "../", "\\"))
        or (len(word) >= 3 and word[0].isalpha() and word[1] == ":" and word[2] in "/\\")
        else word
        for word in words
    ]


def _literal_text(data, **_kwargs):
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], str):
        raise TypeError("Punctuation requires exactly one literal text string")
    return data


def generate_punctuation(auto_model, text):
    if not isinstance(text, str):
        raise TypeError("Punctuation input must be literal text")
    model = getattr(auto_model, "model", None)
    if (type(model).__module__, type(model).__name__) != (
        "funasr.models.ct_transformer.model", "CTTransformer"
    ):
        raise ValueError("Unsupported punctuation model; refusing generic input dispatch")
    original = getattr(getattr(model, "inference", None), "__func__", None)
    if not isinstance(original, FunctionType) or not {"load_audio_text_image_video", "split_words"}.issubset(original.__code__.co_names):
        raise ValueError("Unsupported punctuation inference; literal boundary needs review")
    if not text.strip():
        return [{"text": text}]
    scope = dict(original.__globals__)
    scope["load_audio_text_image_video"] = _literal_text
    split = scope["split_words"]
    scope["split_words"] = lambda value, **kwargs: _literal_words(split, value, **kwargs)
    inference = FunctionType(original.__code__, scope, original.__name__, original.__defaults__, original.__closure__)
    inference.__kwdefaults__ = original.__kwdefaults__
    options = dict(auto_model.kwargs)
    options.pop("cache", None)
    options["data_in"] = [text]
    options["key"] = ["wordtaker_literal_text"]
    model.eval()
    with scope["torch"].no_grad():
        results, _metadata = inference(model, **options)
    return results
