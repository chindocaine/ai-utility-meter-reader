# ai-utility-meter-reader

- This app only runs inside the Docker container — its dependencies (e.g. tflite_runtime,
  opencv) are not installed locally. Do not run `python3 main.py`, `python3 -m py_compile`,
  pytest, pip install, or similar locally; use the Dockerfile / docker-compose.yml / docker-build.sh
  to build and run/test instead.
