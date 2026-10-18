#!/usr/bin/env bash
# Runs bootstrap.sh for real inside a throwaway Docker container and checks the result (see bootstrap-inner.sh).
# Needs docker and network access (apt, nodejs.org). Nothing outside the container is touched.
#
#   server/test/bootstrap-in-container.sh [image]      default: debian:stable-slim
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
image=${1:-debian:stable-slim}
exec docker run --rm --memory 1g --cpus 2 --name "coderra-bootstrap-test-$$" \
	-v "$here:/server:ro" "$image" bash /server/test/bootstrap-inner.sh
