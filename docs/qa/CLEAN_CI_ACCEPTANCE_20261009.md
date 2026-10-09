# Clean ordinary-CI source dependency acceptance

The punctuation regression reads actual installed FunASR dispatch functions via
AST. Previously ordinary `ci.yml` installed only pytest/NumPy/SciPy/soundfile;
an independent Python3.11 venv with those declarations reproduces9 failed/48passed
tests because FunASR source is missing. This is a local clean-environment RED,
not a claim that a remote CI failure was observed.

Ordinary CI now additionally installs only the official FunASR1.2.7
`py3-none-any` source wheel, pinned by exact URL and SHA256 in
`tests/python/funasr-source-requirements.txt`. Installation uses isolated pip,
`--no-deps --no-compile --only-binary=:all: --require-hashes`; package version is
asserted without importing FunASR. No Torch, ModelScope, transformer/model runtime,
test skip, weak dispatcher replacement, application dependency or version change.

The same clean venv then collects and passes all57Python tests with no skips;
real iterator/loader source bytes match the official archive, FunASR runtime is
not imported, and heavy AI libraries are neither installed nor imported. Its
CPython3.11 base is independent of the project's generated embedded runtime.
Other tests use tracked source/static manifests and their own temporary fixtures,
not pre-existing generated models/packages. JavaScript414tests also pass locally.

`workflow_dispatch` allows running the exact existing main/PR JS/Python jobs on
the candidate branch. Permissions are explicitly contents:read; no artifact upload
or release publication is added. Actual Linux CI and final-SHA Windows x64
install/runtime/uninstall results are required in `dist/qa/clean-ci-r1` receipts.

This patch changes only tests/CI/documentation. Production source, packaged resources,
version1.29.5 and macOS>=14 remain unchanged. The Mac bundle built at ae4ed956
(ASAR SHA256 cf94366de0348c2bbaf8c29a75161fe2096e27b2dd2b706a07f3acdd8a36279d)
is retained with explicit source/package byte-equivalence proof, not represented
as newly rebuilt or signed at the later CI-only commit. Prior phase receipts are
immutable. Signing, real-device and previously disclosed risk boundaries remain.
