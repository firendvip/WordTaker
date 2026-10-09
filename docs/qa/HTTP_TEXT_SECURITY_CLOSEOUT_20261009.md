# Literal punctuation input and bounded HTTP dependency closeout

Candidate scope: macOS arm64 >=14 and Windows x64. Version remains 1.29.5.
No release/tag, unsigned-installer upload, production backend change or primary
application/user-data access is authorized by this acceptance.

## Minimal source boundary

`funasr_punctuation.py` is an application-owned adapter for the existing pinned
CTTransformer. Both AutoModel's iterator and CTTransformer's generic loader can
dispatch text as a URL/file; `data_type=text` and wrapping text in a list do not
close both paths. The adapter calls the same model inference bytecode with private
globals: a validated literal-text loader and a splitting wrapper that prevents
URL/path-word capitalization from changing their case. It never patches installed
FunASR or model globals, loads different weights, rewrites the punctuation algorithm,
changes Torch/JIT policy, or adds safe globals. Unknown inference contracts fail
closed; the existing service catches failures and keeps original raw text.

Whole-audio, segmented-audio and warmup all use this boundary. The adapter is
explicitly included in `files` and `asarUnpack`; importing it does not import Torch,
so Windows retains its ONNX-only path. Original raw_text and processed text remain
distinct; requested/actual engine and fallback fields are unchanged.

Regression fixtures cover HTTP/HTTPS, an existing local text file, relative and
Windows-like paths, Chinese/mixed/short/long/empty/whitespace text, failure fallback
and unchanged globals. Spies exercise the actual installed iterator/loader functions,
not a mocked application wrapper. Separate trusted-model checks compare original
punctuation text/arrays on normal input and prove literal URL/path case retention
without downloader, file-open or path-lookup calls.

## Only three HTTP package updates

Official exact PyPI wheels are pinned by URL, wheel SHA256, complete package-file
count/hash and METADATA/WHEEL hashes in `scripts/macOS-python-wheels.js`:

- requests 2.34.2
- urllib3 2.8.0
- certifi 2026.6.17 (code reports equivalent normalized version 2026.06.17)

Python 3.11/OpenSSL 3.0.11 and existing actual idna 3.4 / charset-normalizer 2.1.1
satisfy these constraints. No extras or resolver are enabled for the bounded
adoption. All three installed code/data files and wheel metadata match the official
archives; every hashed installed RECORD entry is validated before retiring only
their four obsolete metadata directories recoverably. 29,245 other runtime files
and symlinks, including Python/NumPy/FunASR/ModelScope/Torch/LLM/native dependencies,
remain byte/mode/link-identical. The whole baseline runtime is preserved in this
phase's local QA directory. The stale idna/charset/ModelScope metadata is not cleaned.

HTTP acceptance uses default verified TLS against a fixed commit/hash public model
file, rejects an untrusted local TLS fixture, and uses a fixture CA only for bounded
local tests. Synthetic origin/proxy credentials exercise real redirects and an HTTPS
CONNECT tunnel without exposing proxy credentials to the TLS origin. Safe, small
gzip/chunked fixtures exercise streaming with explicit byte bounds; no malicious
stress/exploit payload is used. Production's fixed HTTPS downloader is checked
separately using its standard-library TLS, not falsely described as certifi-backed.

## Receipts and remaining boundaries

Fresh evidence lives in `dist/qa/http-text-security-r1`; the prior Torch and
installation phase receipts/packages are immutable. Final local receipts must link
the clean candidate SHA, rebuilt unsigned Mac arm64 directory package and fresh
Windows x64 install/runtime/uninstall CI at that same SHA before delivery.

Retained boundaries: idna 3.4 and dormant vendored HTTP copies are not patched;
the transcript-controlled arbitrary-URL route is closed and fixed model hostnames
are ASCII, not a blanket claim that every dormant library/API is safe. Trusted
FunASR JIT compilation remains the previously disclosed Torch residual. This is
not an exhaustive whole-stack advisory scan or a zero-risk declaration.

Windows acceptance's firewall blocks ONLY KittyEcho.exe outbound, not Python or
other child executables; no whole-process-tree OS network isolation is claimed.
Mac packaged UI uses the existing isolated host/fixtures, not the normal product
entry, OS Keychain/TCC/microphone or a macOS14 physical-device/signing acceptance.
Trusted signing/notarization and genuine device acceptance remain separate gates.
